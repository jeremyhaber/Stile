#!/usr/bin/perl
# Sidebar native messaging host (one process per Chrome profile).
# Core modules only; runs on the stock macOS /usr/bin/perl.
#
# STDOUT carries ONLY framed native-messaging messages. Everything else goes
# to helper.log.
use strict;
use warnings;

use JSON::PP ();
use IO::Socket::UNIX ();
use IO::Select ();
use Socket qw(SOCK_STREAM pack_sockaddr_un);
use Time::HiRes ();
use Fcntl qw(:DEFAULT :flock :seek);
use POSIX ();
use File::Path qw(make_path);
use Digest::MD5 qw(md5_hex);
use MIME::Base64 ();

my $HOST_VERSION = '1.1.0';
my $MAX_PICTURE  = 150 * 1024;
my $MAX_REPLY    = 900 * 1000;    # keep hello/profiles replies under 900 KB
my %ICONS = map { $_ => 1 } qw(picture initial home briefcase code star heart book music camera palette rocket leaf coffee game globe bolt moon);
my $MAX_MSG      = 64 * 1024 * 1024;
my $SUN_PATH_MAX = 100;    # macOS sun_path is 104 bytes incl. NUL; stay under.

my $HOME = $ENV{HOME} || (getpwuid($<))[7] || '/tmp';
my $HELPER_DIR  = $ENV{SIDEBAR_HELPER_DIR}  || "$HOME/Library/Application Support/SidebarHelper";
my $LOCAL_STATE = $ENV{SIDEBAR_LOCAL_STATE} || "$HOME/Library/Application Support/Google/Chrome/Local State";
my $CHROME_BIN  = $ENV{SIDEBAR_CHROME_BIN}  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

my $SOCK_DIR    = "$HELPER_DIR/sock";
my $PENDING_DIR = "$HELPER_DIR/pending";
my $STATE_FILE  = "$HELPER_DIR/state.json";
my $LOG_FILE    = "$HELPER_DIR/helper.log";

my $json = JSON::PP->new->utf8->canonical;

my $main_pid = $$;
my $profile_dir;          # profile this helper serves (after identify)
my $listener;             # IO::Socket::UNIX
my $sock_path;            # path we bound
my @sock_id;              # (dev, ino) of our socket file
my %clients;              # fileno => { fh, buf, t }
my $inbuf = '';
my $stdin_open = 1;

# Relay to the Mac app (overlay socket).
my $app;                  # connected IO::Socket::UNIX, or undef
my $app_in = '';          # partial line from the app
my $app_out = '';         # unsent bytes to the app
my $app_discard = 0;      # skipping an oversized line until its newline
my $app_next_try = 0;     # Time::HiRes time of the next connect attempt
my $last_hello = '';      # last profileHello payload sent on this connection
my $APP_RETRY    = 3;
my $MAX_APP_LINE = 2 * 1024 * 1024;     # lines up to 1 MB are expected; allow slack
my $MAX_APP_OUT  = 16 * 1024 * 1024;    # app not reading -> drop the connection

# ---------------------------------------------------------------- logging
sub logmsg {
    my ($m) = @_;
    my @t = localtime;
    my $ts = sprintf('%04d-%02d-%02d %02d:%02d:%02d', $t[5] + 1900, $t[4] + 1, @t[3, 2, 1, 0]);
    eval {
        make_path($HELPER_DIR) unless -d $HELPER_DIR;
        if (-s $LOG_FILE && -s _ > 1_048_576) {
            rename $LOG_FILE, "$LOG_FILE.1";
        }
        if (open my $fh, '>>', $LOG_FILE) {
            my $who = defined $profile_dir ? $profile_dir : '-';
            print $fh "$ts [$$] [$who] $m\n";
            close $fh;
        }
    };
}

# ---------------------------------------------------------------- cleanup
sub cleanup_socket {
    return unless $$ == $main_pid;
    if (defined $sock_path && @sock_id) {
        my @st = stat $sock_path;
        # Only remove it if it is still OUR socket file (a newer helper for the
        # same profile may already have replaced it).
        unlink $sock_path if @st && $st[0] == $sock_id[0] && $st[1] == $sock_id[1];
    }
    @sock_id = ();
    $sock_path = undef;
}
END { cleanup_socket(); }

$SIG{PIPE} = 'IGNORE';
$SIG{CHLD} = 'IGNORE';    # auto-reap launched Chrome processes
for my $s (qw(TERM INT HUP)) {
    $SIG{$s} = sub { logmsg("signal $s, exiting"); exit 0; };
}
$SIG{__WARN__} = sub { logmsg("warn: $_[0]") };

# ---------------------------------------------------------------- framing
sub write_all {
    my ($fh, $data) = @_;
    my $off = 0;
    my $len = length $data;
    while ($off < $len) {
        my $n = syswrite($fh, $data, $len - $off, $off);
        if (!defined $n) {
            next if $!{EINTR};
            if ($!{EAGAIN}) { select(undef, undef, undef, 0.01); next; }
            return 0;
        }
        $off += $n;
    }
    return 1;
}

sub send_ext {
    my ($msg) = @_;
    my $payload = $json->encode($msg);
    my $ok = write_all(\*STDOUT, pack('L', length $payload) . $payload);
    unless ($ok) {
        logmsg("stdout write failed ($!), exiting");
        exit 0;
    }
}

sub reply {
    my ($req, $msg) = @_;
    $msg->{requestId} = $req->{requestId} if exists $req->{requestId};
    send_ext($msg);
}

# ---------------------------------------------------------------- paths
sub safe_name {
    my ($d) = @_;
    (my $s = $d) =~ s/[^A-Za-z0-9._-]/_/g;
    return $s;
}

# Unix socket paths are limited to ~104 bytes on macOS. Normal path is
# <HELPER_DIR>/sock/<safe>.sock. If that is too long we fall back to
# <HELPER_DIR>/sock/<md5-12>.sock, and if even that is too long to
# /tmp/sbh-<uid>-<md5-12>.sock. The choice is a pure function of
# (HELPER_DIR, profileDir) so every helper computes the same path.
sub sock_path_for {
    my ($d) = @_;
    my $p = "$SOCK_DIR/" . safe_name($d) . '.sock';
    return $p if length($p) <= $SUN_PATH_MAX;
    my $h = substr(md5_hex($d), 0, 12);
    $p = "$SOCK_DIR/$h.sock";
    return $p if length($p) <= $SUN_PATH_MAX;
    return "/tmp/sbh-$<-" . substr(md5_hex("$HELPER_DIR\0$d"), 0, 12) . '.sock';
}

# <HELPER_DIR>/overlay.sock, else <HELPER_DIR>/sock/<md5-12 of "overlay">.sock,
# else /tmp/sbh-<uid>-<md5-12>.sock (same fallback scheme as sock_path_for).
sub overlay_path {
    my $p = "$HELPER_DIR/overlay.sock";
    return $p if length($p) <= $SUN_PATH_MAX;
    $p = "$SOCK_DIR/" . substr(md5_hex('overlay'), 0, 12) . '.sock';
    return $p if length($p) <= $SUN_PATH_MAX;
    return "/tmp/sbh-$<-" . substr(md5_hex("$HELPER_DIR\0overlay"), 0, 12) . '.sock';
}

sub pending_path_for { return "$PENDING_DIR/" . safe_name($_[0]) . '.json'; }

# ---------------------------------------------------------------- Local State
sub color_hex {
    my ($n) = @_;
    return undef unless defined $n && !ref($n) && $n =~ /^-?\d+$/;
    $n += 4294967296 if $n < 0;
    return sprintf('#%06x', $n & 0xFFFFFF);
}

sub clean_style {
    my ($s) = @_;
    return undef unless ref $s eq 'HASH';
    my ($i, $c) = @$s{qw(icon color)};
    return undef unless defined $i && !ref $i && $ICONS{$i};
    return undef unless defined $c && !ref $c && $c =~ /^#[0-9a-fA-F]{6}$/;
    return { icon => "$i", color => "$c" };
}

sub read_picture {
    my ($data_dir, $dir, $e) = @_;
    my $file = 'Google Profile Picture.png';
    my $g = $e->{gaia_picture_file_name};
    $file = $g if defined $g && !ref $g && $g ne '' && $g !~ m{[/\\]} && $g ne '..' && $g ne '.';
    return undef if $dir =~ m{[/\\]} || $dir eq '..' || $dir eq '.';
    my $path = "$data_dir/$dir/$file";
    return undef unless -f $path;
    my $size = -s _;
    return undef if !$size || $size > $MAX_PICTURE;
    open my $fh, '<:raw', $path or return undef;
    local $/;
    my $raw = <$fh>;
    close $fh;
    return undef unless defined $raw && length $raw;
    return 'data:image/png;base64,' . MIME::Base64::encode_base64($raw, '');
}

# Profiles list, with pictures dropped largest-first if the encoded list would
# push a reply over the cap.
sub profiles_capped {
    my $list = read_profiles();
    my $size = length $json->encode($list);
    if ($size > $MAX_REPLY - 4096) {
        for my $p (sort { length($b->{picture} // '') <=> length($a->{picture} // '') } grep { defined $_->{picture} } @$list) {
            $size -= length($p->{picture});
            $p->{picture} = undef;
            last if $size <= $MAX_REPLY - 4096;
        }
    }
    return $list;
}

sub read_profiles {
    my $data;
    if (open my $fh, '<:raw', $LOCAL_STATE) {
        local $/;
        $data = <$fh>;
        close $fh;
    } else {
        logmsg("cannot read Local State '$LOCAL_STATE': $!");
        return [];
    }
    my $ls = eval { JSON::PP->new->utf8->decode($data) };
    if (!$ls || ref $ls ne 'HASH') {
        logmsg("Local State parse error: " . ($@ || 'not an object'));
        return [];
    }
    my $prof  = ref $ls->{profile} eq 'HASH' ? $ls->{profile} : {};
    my $cache = ref $prof->{info_cache} eq 'HASH' ? $prof->{info_cache} : {};
    my %by;
    my $data_dir = $LOCAL_STATE;
    $data_dir =~ s{/[^/]*$}{};
    $data_dir = '.' if $data_dir eq '' || $data_dir eq $LOCAL_STATE;
    my $styles = read_state()->{profileStyles};
    $styles = {} unless ref $styles eq 'HASH';
    for my $dir (keys %$cache) {
        next if $dir =~ /^(?:Guest|System)/;
        my $e = $cache->{$dir};
        next unless ref $e eq 'HASH';
        my $col = color_hex($e->{profile_highlight_color});
        $col = color_hex($e->{default_avatar_fill_color}) unless defined $col;
        $by{$dir} = {
            dir   => $dir,
            name  => defined $e->{name} && !ref $e->{name} ? "$e->{name}" : $dir,
            email => defined $e->{user_name} && !ref $e->{user_name} ? "$e->{user_name}" : '',
            color => $col,
            picture => read_picture($data_dir, $dir, $e),
            style   => clean_style($styles->{$dir}),
        };
    }
    my @out;
    my %seen;
    if (ref $prof->{profiles_order} eq 'ARRAY') {
        for my $d (@{ $prof->{profiles_order} }) {
            next if !defined $d || ref $d || $seen{$d} || !$by{$d};
            push @out, $by{$d};
            $seen{$d} = 1;
        }
    }
    my @rest = grep { !$seen{$_} } keys %by;
    @rest = sort {
        (($a eq 'Default') ? 0 : 1) <=> (($b eq 'Default') ? 0 : 1)
            || lc($by{$a}{name}) cmp lc($by{$b}{name})
            || $a cmp $b
    } @rest;
    push @out, map { $by{$_} } @rest;
    return \@out;
}

# ---------------------------------------------------------------- state.json
sub valid_minutes { return defined $_[0] && !ref $_[0] && $_[0] =~ /^\d+$/; }

sub with_state_lock {
    my ($mode, $cb) = @_;
    make_path($HELPER_DIR) unless -d $HELPER_DIR;
    sysopen(my $fh, $STATE_FILE, O_RDWR | O_CREAT, 0600) or do {
        logmsg("cannot open state file: $!");
        return $cb->({}, undef);
    };
    flock($fh, $mode) or logmsg("flock failed: $!");
    local $/;
    seek($fh, 0, SEEK_SET);
    my $raw = <$fh>;
    my $st;
    $st = eval { JSON::PP->new->utf8->decode($raw) } if defined $raw && length $raw;
    $st = {} unless ref $st eq 'HASH';
    my $res = $cb->($st, $fh);
    close $fh;    # releases lock
    return $res;
}

sub read_state {
    return with_state_lock(LOCK_SH, sub { return { %{ $_[0] } }; });
}

sub settings_from {
    my ($st) = @_;
    my $m = valid_minutes($st->{archiveDefaultMinutes}) ? $st->{archiveDefaultMinutes} + 0 : 720;
    return { archiveDefaultMinutes => $m };
}

sub update_state {
    my ($changes) = @_;
    return with_state_lock(LOCK_EX, sub {
        my ($st, $fh) = @_;
        @$st{ keys %$changes } = values %$changes;
        if ($fh) {
            seek($fh, 0, SEEK_SET);
            truncate($fh, 0);
            my $out = $json->encode($st);
            write_all($fh, $out . "\n") or logmsg("state write failed: $!");
        }
        return settings_from($st);
    });
}

# ---------------------------------------------------------------- sockets
sub peer_send {
    my ($path, $msg) = @_;
    return 0 unless -S $path;
    my $s = IO::Socket::UNIX->new(Peer => $path, Type => SOCK_STREAM, Timeout => 1) or return 0;
    my $ok = defined $msg ? write_all($s, $json->encode($msg) . "\n") : 1;
    close $s;
    return $ok;
}

sub peer_alive { return peer_send($_[0], undef); }

sub close_listener {
    if ($listener) { close $listener; $listener = undef; }
    cleanup_socket();
}

sub bind_socket {
    my ($dir) = @_;
    my $path = sock_path_for($dir);
    make_path($SOCK_DIR);
    chmod 0700, $SOCK_DIR;
    if (-e $path || -l $path) {
        if (peer_alive($path)) {
            logmsg("older helper alive on $path, asking it to shut down");
            peer_send($path, { type => 'shutdown' });
            for (1 .. 60) {
                select(undef, undef, undef, 0.05);
                last unless peer_alive($path);
            }
            logmsg("older helper still alive after wait, replacing socket anyway")
                if peer_alive($path);
        }
        unlink $path;
    }
    my $l = IO::Socket::UNIX->new(Local => $path, Type => SOCK_STREAM, Listen => 16)
        or die "bind $path: $!\n";
    chmod 0600, $path;
    $l->blocking(0);
    @sock_id = (stat $path)[0, 1];
    $sock_path = $path;
    $listener = $l;
    logmsg("listening on $path");
}

# ---------------------------------------------------------------- app relay
sub drop_app {
    my ($why) = @_;
    return unless $app;
    close $app;
    $app = undef;
    ($app_in, $app_out, $app_discard, $last_hello) = ('', '', 0, '');
    $app_next_try = Time::HiRes::time() + $APP_RETRY;
    logmsg("overlay app disconnected ($why)");
    send_ext({ type => 'overlayStatus', connected => JSON::PP::false });
}

sub flush_app {
    while ($app && length $app_out) {
        my $n = syswrite($app, $app_out, length $app_out);
        if (!defined $n) {
            next if $!{EINTR};
            return if $!{EAGAIN} || $!{EWOULDBLOCK};
            return drop_app("write error: $!");
        }
        substr($app_out, 0, $n, '');
    }
}

sub app_send {
    my ($msg) = @_;
    return unless $app;
    $app_out .= $json->encode($msg) . "\n";
    return drop_app('output backlog too large') if length $app_out > $MAX_APP_OUT;
    flush_app();
}

sub send_profile_hello {
    my ($only_if_changed) = @_;
    return unless $app && defined $profile_dir;
    my $msg = { type => 'profileHello', profileDir => $profile_dir, profiles => profiles_capped() };
    my $enc = $json->encode($msg);
    return if $only_if_changed && $enc eq $last_hello;
    $last_hello = $enc;
    app_send($msg);
}

sub try_connect_app {
    return if $app || !defined $profile_dir;
    return if Time::HiRes::time() < $app_next_try;
    $app_next_try = Time::HiRes::time() + $APP_RETRY;
    my $path = overlay_path();
    return unless -S $path;
    my $s = IO::Socket::UNIX->new(Type => SOCK_STREAM) or return;
    $s->blocking(0);
    unless (connect($s, pack_sockaddr_un($path))) { close $s; return; }
    $app = $s;
    ($app_in, $app_out, $app_discard, $last_hello) = ('', '', 0, '');
    logmsg("connected to overlay app at $path");
    send_profile_hello();
    send_ext({ type => 'overlayStatus', connected => JSON::PP::true }) if $app;
}

sub process_app_line {
    my ($line) = @_;
    return unless $line =~ /\S/;
    my $m = eval { JSON::PP->new->utf8->decode($line) };
    if (ref $m ne 'HASH') { logmsg('bad app JSON: ' . ($@ // 'not an object')); return; }
    if (defined $m->{type} && $m->{type} eq 'toExt' && ref $m->{msg} eq 'HASH') {
        send_ext($m->{msg});
    } else {
        logmsg('ignoring app message type ' . (defined $m->{type} && !ref $m->{type} ? "'$m->{type}'" : '(none)'));
    }
}

sub read_app {
    my $n = sysread($app, my $buf, 65536);
    if (!defined $n) { return if $!{EINTR} || $!{EAGAIN} || $!{EWOULDBLOCK}; return drop_app("read error: $!"); }
    return drop_app('EOF') if $n == 0;
    $app_in .= $buf;
    if ($app_discard) {
        my $i = index($app_in, "\n");
        if ($i < 0) { $app_in = ''; return; }
        substr($app_in, 0, $i + 1, '');
        $app_discard = 0;
    }
    while ((my $i = index($app_in, "\n")) >= 0) {
        my $line = substr($app_in, 0, $i);
        substr($app_in, 0, $i + 1, '');
        process_app_line($line);
        return unless $app;
    }
    if (length $app_in > $MAX_APP_LINE) {
        logmsg('oversized app line discarded');
        $app_in = '';
        $app_discard = 1;
    }
}

sub handle_peer_msg {
    my ($m) = @_;
    return unless ref $m eq 'HASH' && defined $m->{type};
    if ($m->{type} eq 'activate') {
        send_ext({ type => 'activate', bounds => $m->{bounds} });
    } elsif ($m->{type} eq 'settings') {
        send_ext({ type => 'settings', settings => $m->{settings} });
    } elsif ($m->{type} eq 'profiles') {
        send_ext({ type => 'profiles', profiles => profiles_capped() });
        send_profile_hello(1);
    } elsif ($m->{type} eq 'shutdown') {
        logmsg('shutdown requested by peer');
        exit 0;
    } else {
        logmsg("unknown peer message type '$m->{type}'");
    }
}

sub process_peer_line {
    my ($line) = @_;
    return unless $line =~ /\S/;
    my $m = eval { JSON::PP->new->utf8->decode($line) };
    if (!defined $m) { logmsg("bad peer JSON: " . ($@ // '')); return; }
    handle_peer_msg($m);
}

# ---------------------------------------------------------------- Chrome launch
sub launch_chrome {
    my ($dir) = @_;
    return "Chrome binary not found or not executable: $CHROME_BIN" unless -f $CHROME_BIN && -x _;
    my $pid = fork();
    return "fork failed: $!" unless defined $pid;
    if ($pid == 0) {
        # Child: fully detach. It must NOT keep the native-messaging stdout.
        eval {
            POSIX::setsid();
            open(STDIN,  '<',  '/dev/null') or POSIX::_exit(126);
            open(STDOUT, '>',  '/dev/null') or POSIX::_exit(126);
            open(STDERR, '>',  '/dev/null') or POSIX::_exit(126);
            close $listener if $listener;
            close $app if $app;
            $_->{fh}->close for values %clients;
            $SIG{CHLD} = 'DEFAULT';
            $SIG{PIPE} = 'DEFAULT';
            $SIG{$_} = 'DEFAULT' for qw(TERM INT HUP);
            exec { $CHROME_BIN } $CHROME_BIN, "--profile-directory=$dir";
        };
        POSIX::_exit(127);
    }
    logmsg("launched Chrome pid $pid for '$dir'");
    return undef;
}

sub write_pending {
    my ($dir, $bounds) = @_;
    make_path($PENDING_DIR);
    my $p = pending_path_for($dir);
    my $tmp = "$p.tmp$$";
    open my $fh, '>', $tmp or return "cannot write pending file: $!";
    print $fh $json->encode({ bounds => $bounds, ts => time });
    close $fh;
    rename $tmp, $p or return "cannot rename pending file: $!";
    return undef;
}

# ---------------------------------------------------------------- handlers
sub bounds_of { my ($b) = @_; return ref $b eq 'HASH' ? $b : undef; }

sub do_hello {
    my ($m) = @_;
    my $st = read_state();
    reply($m, {
        type        => 'hello',
        hostVersion => $HOST_VERSION,
        profiles    => profiles_capped(),
        settings    => settings_from($st),
    });
}

sub do_identify {
    my ($m) = @_;
    my $dir = $m->{profileDir};
    if (!defined $dir || ref $dir || $dir eq '') {
        return reply($m, { type => 'identified', profileDir => $dir, error => 'missing profileDir' });
    }
    if (!defined $profile_dir || $profile_dir ne $dir || !$listener) {
        close_listener();
        $profile_dir = $dir;
        eval { bind_socket($dir); 1 } or do {
            my $e = $@; chomp $e;
            logmsg("identify failed: $e");
            return reply($m, { type => 'identified', profileDir => $dir, error => $e });
        };
    }
    reply($m, { type => 'identified', profileDir => $dir });

    my $pp = pending_path_for($dir);
    if (-e $pp) {
        my $p;
        if (open my $fh, '<:raw', $pp) { local $/; $p = eval { JSON::PP->new->utf8->decode(scalar <$fh>) }; close $fh; }
        unlink $pp;
        if (ref $p eq 'HASH' && defined $p->{ts} && $p->{ts} =~ /^\d+(?:\.\d+)?$/ && time - $p->{ts} < 60) {
            send_ext({ type => 'activate', bounds => bounds_of($p->{bounds}) });
        } else {
            logmsg("ignoring stale/invalid pending handoff for '$dir'");
        }
    }
    send_profile_hello();
}

sub do_switch {
    my ($m) = @_;
    my $t = $m->{targetDir};
    if (!defined $t || ref $t || $t eq '') {
        return reply($m, { type => 'switchResult', ok => JSON::PP::false, error => 'missing targetDir' });
    }
    my $bounds = bounds_of($m->{bounds});
    if (peer_send(sock_path_for($t), { type => 'activate', bounds => $bounds })) {
        logmsg("switch to '$t': focused via socket");
        return reply($m, { type => 'switchResult', ok => JSON::PP::true, method => 'focused' });
    }
    if (my $err = write_pending($t, $bounds)) {
        logmsg("switch to '$t': $err");
        return reply($m, { type => 'switchResult', ok => JSON::PP::false, error => $err });
    }
    if (my $err = launch_chrome($t)) {
        unlink pending_path_for($t);
        logmsg("switch to '$t': $err");
        return reply($m, { type => 'switchResult', ok => JSON::PP::false, error => $err });
    }
    reply($m, { type => 'switchResult', ok => JSON::PP::true, method => 'launched' });
}

sub do_set_settings {
    my ($m) = @_;
    my $s = ref $m->{settings} eq 'HASH' ? $m->{settings} : {};
    my %ch;
    if (exists $s->{archiveDefaultMinutes}) {
        unless (valid_minutes($s->{archiveDefaultMinutes})) {
            return reply($m, { type => 'settings', settings => settings_from(read_state()), error => 'invalid archiveDefaultMinutes' });
        }
        $ch{archiveDefaultMinutes} = $s->{archiveDefaultMinutes} + 0;
    }
    my $new = update_state(\%ch);
    for my $p (@{ read_profiles() }) {
        next if defined $profile_dir && $p->{dir} eq $profile_dir;
        peer_send(sock_path_for($p->{dir}), { type => 'settings', settings => $new });
    }
    reply($m, { type => 'settings', settings => $new });
}

sub do_set_style {
    my ($m) = @_;
    my $dir = $m->{dir};
    my $style = $m->{style};
    my $err;
    if (!defined $dir || ref $dir || $dir eq '') { $err = 'missing dir'; }
    elsif (defined $style) {
        if (ref $style ne 'HASH') { $err = 'invalid style'; }
        elsif (!defined $style->{icon} || ref $style->{icon} || !$ICONS{ $style->{icon} }) { $err = 'invalid icon'; }
        elsif (!defined $style->{color} || ref $style->{color} || $style->{color} !~ /^#[0-9a-fA-F]{6}$/) { $err = 'invalid color'; }
    }
    if (!$err && !grep { $_->{dir} eq $dir } @{ read_profiles() }) { $err = 'unknown profile'; }
    if ($err) {
        return reply($m, { type => 'profiles', profiles => profiles_capped(), error => $err });
    }
    with_state_lock(LOCK_EX, sub {
        my ($st, $fh) = @_;
        my $ps = ref $st->{profileStyles} eq 'HASH' ? $st->{profileStyles} : {};
        if (defined $style) { $ps->{$dir} = { icon => "$style->{icon}", color => lc $style->{color} }; }
        else { delete $ps->{$dir}; }
        $st->{profileStyles} = $ps;
        if ($fh) {
            seek($fh, 0, SEEK_SET);
            truncate($fh, 0);
            write_all($fh, $json->encode($st) . "\n") or logmsg("state write failed: $!");
        }
    });
    my $fresh = profiles_capped();
    for my $p (@$fresh) {
        next if defined $profile_dir && $p->{dir} eq $profile_dir;
        peer_send(sock_path_for($p->{dir}), { type => 'profiles', profiles => $fresh });
    }
    reply($m, { type => 'profiles', profiles => $fresh });
    send_profile_hello(1);
}

my %HANDLERS = (
    hello             => \&do_hello,
    identify          => \&do_identify,
    getProfiles       => sub { reply($_[0], { type => 'profiles', profiles => profiles_capped() }); send_profile_hello(1); },
    setProfileStyle   => \&do_set_style,
    switchProfile     => \&do_switch,
    setGlobalSettings => \&do_set_settings,
);

sub dispatch {
    my ($m) = @_;
    unless (ref $m eq 'HASH' && defined $m->{type} && !ref $m->{type}) {
        logmsg('ignoring message without type');
        return;
    }
    if ($m->{type} eq 'bridgeResult' || $m->{type} eq 'bridgeEvent') {
        app_send({ type => 'fromExt', profileDir => $profile_dir, msg => $m })
            if $app && defined $profile_dir;
        return;
    }
    my $h = $HANDLERS{ $m->{type} };
    unless ($h) {
        logmsg("unknown message type '$m->{type}'");
        return reply($m, { type => 'error', error => "unknown message type '$m->{type}'" });
    }
    eval { $h->($m); 1 } or do {
        my $e = $@; chomp $e;
        logmsg("handler '$m->{type}' died: $e");
        eval { reply($m, { type => 'error', error => "internal error" }) };
    };
}

sub drain_stdin_buffer {
    while (length($inbuf) >= 4) {
        my $len = unpack('L', substr($inbuf, 0, 4));
        if ($len > $MAX_MSG) {
            logmsg("absurd frame length $len, exiting");
            exit 1;
        }
        last if length($inbuf) < 4 + $len;
        my $payload = substr($inbuf, 4, $len);
        substr($inbuf, 0, 4 + $len, '');
        my $m = eval { JSON::PP->new->utf8->decode($payload) };
        if (!defined $m) {
            logmsg('malformed JSON from extension: ' . ($@ // 'null'));
            next;
        }
        dispatch($m);
    }
}

# ---------------------------------------------------------------- main
binmode(STDIN);
binmode(STDOUT);
{ my $o = select(STDOUT); $| = 1; select($o); }

logmsg("started (pid $$, perl $], dir '$HELPER_DIR')");
make_path($HELPER_DIR);

my $sel_in = \*STDIN;

while ($stdin_open) {
    try_connect_app();
    my $sel = IO::Select->new($sel_in);
    $sel->add($listener) if $listener;
    $sel->add($_->{fh}) for values %clients;
    $sel->add($app) if $app;
    my $wsel = IO::Select->new;
    $wsel->add($app) if $app && length $app_out;
    my $tmo = 1;
    if (!$app && defined $profile_dir) {
        my $left = $app_next_try - Time::HiRes::time();
        $tmo = $left if $left < $tmo;
        $tmo = 0.01 if $tmo < 0.01;
    }
    my @res = IO::Select->select($sel, $wsel, undef, $tmo);
    my @ready = @{ $res[0] || [] };
    flush_app() if $app && $res[1] && @{ $res[1] };
    my $now = time;

    for my $fh (@ready) {
        if ($fh == $sel_in) {
            my $n = sysread(STDIN, my $buf, 65536);
            if (!defined $n) { next if $!{EINTR} || $!{EAGAIN}; logmsg("stdin read error: $!"); $stdin_open = 0; last; }
            if ($n == 0) { logmsg('stdin EOF'); $stdin_open = 0; last; }
            $inbuf .= $buf;
            drain_stdin_buffer();
        } elsif ($app && $fh == $app) {
            read_app();
        } elsif ($listener && $fh == $listener) {
            while (my $c = $listener->accept) {
                $c->blocking(0);
                $clients{ fileno $c } = { fh => $c, buf => '', t => $now };
            }
        } else {
            my $key = fileno $fh;
            next unless defined $key;
            my $c = $clients{$key} or next;
            my $n = sysread($fh, my $buf, 65536);
            if (!defined $n) { next if $!{EINTR} || $!{EAGAIN}; $n = 0; }
            if ($n > 0) {
                $c->{buf} .= $buf;
                while ($c->{buf} =~ s/^([^\n]*)\n//) { process_peer_line($1); }
                $c->{buf} = '' if length $c->{buf} > 1_048_576;
            } else {
                process_peer_line($c->{buf}) if length $c->{buf};
                close $fh;
                delete $clients{$key};
            }
        }
    }
    for my $k (keys %clients) {
        next unless $now - $clients{$k}{t} > 5;
        close $clients{$k}{fh};
        delete $clients{$k};
    }
}

logmsg('exiting');
close_listener();
exit 0;
