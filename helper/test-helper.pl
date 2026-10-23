#!/usr/bin/perl
# Test driver for sidebar-helper.pl (works on Linux and macOS).
use strict;
use warnings;
use JSON::PP;
use IPC::Open2;
use IO::Select;
use File::Temp qw(tempdir);
use File::Path qw(make_path);
use File::Basename qw(dirname);
use Cwd qw(abs_path);
use POSIX qw(:sys_wait_h);
use MIME::Base64 ();
use IO::Socket::UNIX;
use Socket ();
use Digest::MD5 qw(md5_hex);

$| = 1;
my $HELPER = dirname(abs_path($0)) . '/sidebar-helper.pl';
my $json = JSON::PP->new->utf8->canonical;

my ($pass, $fail) = (0, 0);
sub check {
    my ($ok, $name, $detail) = @_;
    if ($ok) { $pass++; print "PASS  $name\n"; }
    else { $fail++; print "FAIL  $name" . (defined $detail ? "  ($detail)" : '') . "\n"; }
    return $ok;
}
sub wait_for {
    my ($cond, $secs) = @_;
    my $end = time + ($secs // 5);
    while (time <= $end) { return 1 if $cond->(); select(undef, undef, undef, 0.05); }
    return $cond->() ? 1 : 0;
}
sub slurp { open my $f, '<', $_[0] or return ''; local $/; my $c = <$f>; close $f; return $c; }
sub dump_json { my $s = eval { $json->canonical->encode($_[0]) }; return $s // 'undef'; }

# ------------------------------------------------------------ environment
my $tmp = tempdir('sbtest-XXXXXX', TMPDIR => 1, CLEANUP => 1);
my $hdir = "$tmp/helper";
my $local_state = "$tmp/Local State";
my $chrome_args = "$tmp/chrome-args.txt";
my $fake_chrome = "$tmp/fake-chrome.sh";

open my $fc, '>', $fake_chrome or die;
print $fc "#!/bin/sh\n";
print $fc "printf '%s\\n' \"\$*\" >> '$chrome_args'\n";
print $fc "sleep 3\n";    # lingers, to prove the helper's stdout was not inherited
close $fc;
chmod 0755, $fake_chrome;

sub write_local_state {
    my ($order) = @_;
    my %ls = (profile => {
        info_cache => {
            'Default'   => { name => 'Personal', user_name => 'me@example.com',
                             profile_highlight_color => -16776961 },   # 0xFF0000FF -> #0000ff
            'Profile 1' => { name => 'Work', user_name => 'me@work.example',
                             profile_highlight_color => -2383999,      # 0xFFDB9F81 -> #db9f81
                             default_avatar_fill_color => -1 },
            'Profile 2' => { name => 'Hobby', user_name => '',
                             default_avatar_fill_color => -16711936 },  # 0xFF00FF00 -> #00ff00
            'Guest Profile' => { name => 'Guest' },
            'System Profile' => { name => 'System' },
        },
        ($order ? (profiles_order => $order) : ()),
    });
    open my $f, '>', $local_state or die;
    print $f $json->encode(\%ls);
    close $f;
}
write_local_state(['Profile 1', 'Default', 'Profile 2']);

my %ENV_BASE = (
    SIDEBAR_HELPER_DIR  => $hdir,
    SIDEBAR_LOCAL_STATE => $local_state,
    SIDEBAR_CHROME_BIN  => $fake_chrome,
);

# ------------------------------------------------------------ helper process wrapper
package Helper;
sub spawn {
    my ($class, %env) = @_;
    local @ENV{ keys %env } = values %env;
    my $pid = IPC::Open2::open2(my $out, my $in, $^X, $HELPER) or die "spawn: $!";
    binmode $out; binmode $in;
    my $s = bless { pid => $pid, out => $out, in => $in, buf => '', msgs => [], eof => 0 }, $class;
    return $s;
}
sub send_raw {
    my ($s, $bytes) = @_;
    my $in = $s->{in};
    syswrite($in, $bytes);
}
sub send {
    my ($s, $m) = @_;
    my $p = $json->encode($m);
    $s->send_raw(pack('L', length $p) . $p);
}
sub pump {
    my ($s, $timeout) = @_;
    return if $s->{eof};
    my $sel = IO::Select->new($s->{out});
    while ($sel->can_read($timeout)) {
        my $n = sysread($s->{out}, my $b, 65536);
        if (!$n) { $s->{eof} = 1; last; }
        $s->{buf} .= $b;
        while (length $s->{buf} >= 4) {
            my $len = unpack('L', substr($s->{buf}, 0, 4));
            last if length $s->{buf} < 4 + $len;
            my $pl = substr($s->{buf}, 4, $len);
            substr($s->{buf}, 0, 4 + $len, '');
            push @{ $s->{msgs} }, $json->decode($pl);
        }
        $timeout = 0.05;
    }
}
# Wait for the next message (optionally matching a type).
sub recv {
    my ($s, $type, $secs) = @_;
    my $end = time + ($secs // 5);
    while (1) {
        for my $i (0 .. $#{ $s->{msgs} }) {
            if (!defined $type || $s->{msgs}[$i]{type} eq $type) {
                return splice(@{ $s->{msgs} }, $i, 1);
            }
        }
        return undef if time > $end || $s->{eof};
        $s->pump(0.1);
    }
}
sub request {
    my ($s, $m, $type) = @_;
    $s->send($m);
    my %rt = (getProfiles => 'profiles', identify => 'identified', switchProfile => 'switchResult', setGlobalSettings => 'settings', setProfileStyle => 'profiles');
    return $s->recv($type // $rt{ $m->{type} } // $m->{type});
}
sub quiet_for {    # true if nothing arrives within N seconds
    my ($s, $secs) = @_;
    $s->pump($secs);
    return !@{ $s->{msgs} };
}
sub close_stdin { my $s = shift; close $s->{in}; }
sub exited {
    my ($s) = @_;
    return 1 if $s->{done};
    my $r = waitpid($s->{pid}, POSIX::WNOHANG());
    $s->{done} = 1 if $r == $s->{pid} || $r == -1;
    return $s->{done} ? 1 : 0;
}
sub kill_it { my $s = shift; kill 'TERM', $s->{pid}; waitpid($s->{pid}, 0) unless $s->{done}; $s->{done} = 1; }

package main;

# ------------------------------------------------------------ fake Mac app (overlay socket)
package FakeApp;
sub listen {
    my ($class, $path) = @_;
    unlink $path;
    my $l = IO::Socket::UNIX->new(Local => $path, Type => Socket::SOCK_STREAM(), Listen => 5) or die "fake app listen $path: $!";
    return bless { path => $path, l => $l, conn => undef, buf => '', lines => [], eof => 0 }, $class;
}
sub accept {
    my ($s, $secs) = @_;
    return 0 unless IO::Select->new($s->{l})->can_read($secs // 6);
    my $c = $s->{l}->accept or return 0;
    binmode $c; $c->blocking(0);
    @$s{qw(conn buf lines eof)} = ($c, '', [], 0);
    return 1;
}
sub pump {
    my ($s, $timeout) = @_;
    return if !$s->{conn} || $s->{eof};
    my $sel = IO::Select->new($s->{conn});
    while ($sel->can_read($timeout)) {
        my $n = sysread($s->{conn}, my $b, 65536);
        if (!$n) { $s->{eof} = 1 if defined $n || !$!{EAGAIN}; last; }
        $s->{buf} .= $b;
        while ((my $i = index($s->{buf}, "\n")) >= 0) {
            my $l = substr($s->{buf}, 0, $i); substr($s->{buf}, 0, $i + 1, '');
            push @{ $s->{lines} }, $json->decode($l);
        }
        $timeout = 0.05;
    }
}
sub recv {
    my ($s, $type, $secs) = @_;
    my $end = time + ($secs // 5);
    while (1) {
        for my $i (0 .. $#{ $s->{lines} }) {
            return splice(@{ $s->{lines} }, $i, 1) if !defined $type || $s->{lines}[$i]{type} eq $type;
        }
        return undef if time > $end || $s->{eof};
        $s->pump(0.1);
    }
}
sub quiet_for { my ($s, $secs) = @_; $s->pump($secs); return !@{ $s->{lines} }; }
sub send_raw {
    my ($s, $bytes, $cb) = @_;
    my $off = 0;
    my $sel = IO::Select->new($s->{conn});
    while ($off < length $bytes) {
        my $n = syswrite($s->{conn}, $bytes, 32768, $off);
        if (defined $n) { $off += $n; $cb->() if $cb; next; }
        $sel->can_write(0.05); $cb->() if $cb;
    }
}
sub send { my ($s, $m, $cb) = @_; $s->send_raw($json->encode($m) . "\n", $cb); }
sub drop_conn { my $s = shift; close $s->{conn} if $s->{conn}; $s->{conn} = undef; }
sub stop { my $s = shift; $s->drop_conn; close $s->{l} if $s->{l}; $s->{l} = undef; unlink $s->{path}; }

package main;

my @all;
sub spawn { my $h = Helper->spawn(%ENV_BASE, @_); push @all, $h; return $h; }

my $sockdir = "$hdir/sock";

# ------------------------------------------------------------ 1. hello / profiles
my $A = spawn();
my $A_alive;
my $r = $A->request({ type => 'hello', extVersion => '0.1', requestId => 7 });
check($r && $r->{type} eq 'hello', 'hello: reply received', dump_json($r));
check($r && $r->{requestId} == 7, 'hello: requestId echoed');
check($r && defined $r->{hostVersion} && length $r->{hostVersion}, 'hello: hostVersion present');
my @p = @{ $r->{profiles} // [] };
check(@p == 3, 'hello: 3 profiles (Guest/System skipped)', scalar(@p));
check(join(',', map { $_->{dir} } @p) eq 'Profile 1,Default,Profile 2', 'hello: profiles_order respected',
      join(',', map { $_->{dir} } @p));
my %by = map { $_->{dir} => $_ } @p;
check($by{Default}{color} eq '#0000ff', 'colour: negative ARGB profile_highlight_color -> #0000ff', $by{Default}{color});
check($by{'Profile 1'}{color} eq '#db9f81', 'colour: highlight preferred over avatar fill', $by{'Profile 1'}{color});
check($by{'Profile 2'}{color} eq '#00ff00', 'colour: falls back to default_avatar_fill_color', $by{'Profile 2'}{color});
check($by{Default}{email} eq 'me@example.com' && $by{Default}{name} eq 'Personal', 'profile name and email parsed');
check($by{'Profile 2'}{email} eq '', 'empty email is ""');
check(ref $r->{settings} eq 'HASH' && $r->{settings}{archiveDefaultMinutes} == 720, 'hello: default archiveDefaultMinutes 720');

# getProfiles with no profiles_order -> Default first, then by name
write_local_state(undef);
$r = $A->request({ type => 'getProfiles', requestId => 'g1' });
check($r && $r->{requestId} eq 'g1', 'getProfiles: requestId echoed');
check(join(',', map { $_->{dir} } @{ $r->{profiles} // [] }) eq 'Default,Profile 2,Profile 1',
      'getProfiles: no order -> Default first then by name',
      join(',', map { $_->{dir} } @{ $r->{profiles} // [] }));
write_local_state(['Profile 1', 'Default', 'Profile 2']);

# ------------------------------------------------------------ 2. identify
my $B = spawn();
$r = $A->request({ type => 'identify', profileDir => 'Default', requestId => 1 });
check($r && $r->{profileDir} eq 'Default' && $r->{requestId} == 1, 'identify A as Default', dump_json($r));
$r = $B->request({ type => 'identify', profileDir => 'Profile 1' });
check($r && $r->{profileDir} eq 'Profile 1', 'identify B as Profile 1', dump_json($r));
check(-S "$sockdir/Default.sock", 'socket for Default exists');
check(-S "$sockdir/Profile_1.sock", 'socket for "Profile 1" exists (sanitised name)');

# ------------------------------------------------------------ 3. switch to identified profile
my $bounds = { left => 10, top => 20, width => 1200, height => 800, state => 'normal' };
$r = $A->request({ type => 'switchProfile', targetDir => 'Profile 1', bounds => $bounds, requestId => 2 });
check($r && $r->{ok} && $r->{method} eq 'focused' && $r->{requestId} == 2, 'switch -> identified: focused', dump_json($r));
my $act = $B->recv('activate');
check($act && dump_json($act->{bounds}) eq dump_json($bounds), 'switch -> identified: target helper emits activate with same bounds', dump_json($act));
check(!-e $chrome_args, 'switch -> identified: Chrome not launched');

# ------------------------------------------------------------ 4. switch to unidentified profile
my $b2 = { left => 0, top => 0, width => 1440, height => 900, state => 'maximized' };
$r = $A->request({ type => 'switchProfile', targetDir => 'Profile 2', bounds => $b2 });
check($r && $r->{ok} && $r->{method} eq 'launched', 'switch -> unidentified: launched', dump_json($r));
check(wait_for(sub { -s $chrome_args }), 'fake chrome ran');
check(slurp($chrome_args) =~ /^--profile-directory=Profile 2$/m, 'fake chrome got --profile-directory=Profile 2', slurp($chrome_args));
my $pf = "$hdir/pending/Profile_2.json";
check(-f $pf, 'pending file written');
my $pj = eval { $json->decode(slurp($pf)) } || {};
check(dump_json($pj->{bounds}) eq dump_json($b2) && abs(time - ($pj->{ts} // 0)) < 10, 'pending file has bounds and ts', slurp($pf));

# ------------------------------------------------------------ 5. identify consumes pending
my $C = spawn();
$r = $C->request({ type => 'identify', profileDir => 'Profile 2' });
check($r && $r->{profileDir} eq 'Profile 2', 'identify C as Profile 2');
$act = $C->recv('activate');
check($act && dump_json($act->{bounds}) eq dump_json($b2), 'identify with pending: activate emitted with stored bounds', dump_json($act));
check(!-e $pf, 'pending file deleted after use');

# stale pending is ignored (and removed)
open my $sf, '>', "$hdir/pending/Stale_X.json" or die; print $sf $json->encode({ bounds => $bounds, ts => time - 120 }); close $sf;
my $S = spawn();
$S->request({ type => 'identify', profileDir => 'Stale X' });
check($S->quiet_for(0.5), 'stale (>60s) pending handoff does not activate');
check(!-e "$hdir/pending/Stale_X.json", 'stale pending file removed');

# ------------------------------------------------------------ 6. setGlobalSettings
$r = $A->request({ type => 'setGlobalSettings', settings => { archiveDefaultMinutes => 1440 }, requestId => 3 });
check($r && $r->{type} eq 'settings' && $r->{settings}{archiveDefaultMinutes} == 1440 && $r->{requestId} == 3, 'setGlobalSettings: reply', dump_json($r));
my $st = eval { $json->decode(slurp("$hdir/state.json")) } || {};
check($st->{archiveDefaultMinutes} == 1440, 'setGlobalSettings: persisted to state.json', slurp("$hdir/state.json"));
for my $pair (['B', $B], ['C', $C]) {
    my $m = $pair->[1]->recv('settings');
    check($m && $m->{settings}{archiveDefaultMinutes} == 1440, "setGlobalSettings: broadcast to helper $pair->[0]", dump_json($m));
}
check($A->quiet_for(0.3), 'setGlobalSettings: sender gets no unsolicited settings');
my $D0 = spawn();
$r = $D0->request({ type => 'hello' });
check($r && $r->{settings}{archiveDefaultMinutes} == 1440, 'hello after set: new helper reads persisted settings');
$r = $A->request({ type => 'setGlobalSettings', settings => { archiveDefaultMinutes => 0 } });
check($r && $r->{settings}{archiveDefaultMinutes} == 0, '0 (never) is accepted');
$r = $A->request({ type => 'setGlobalSettings', settings => { archiveDefaultMinutes => 'abc' } });
check($r && $r->{error}, 'invalid archiveDefaultMinutes rejected', dump_json($r));
$r = $A->request({ type => 'setGlobalSettings', settings => { archiveDefaultMinutes => 720 } });
$D0->close_stdin;

# ------------------------------------------------------------ 7. robustness: malformed, split, coalesced
$A->send_raw(pack('L', 8) . 'not json');
$r = $A->request({ type => 'getProfiles', requestId => 'after-bad' });
check($r && $r->{requestId} eq 'after-bad', 'malformed JSON frame: helper survives and continues');

$A->send({ type => 'bogus', requestId => 'u1' });
$r = $A->recv('error');
check($r && $r->{requestId} eq 'u1', 'unknown type: error reply with requestId', dump_json($r));

{
    my $p1 = $json->encode({ type => 'getProfiles', requestId => 's1' });
    my $frame = pack('L', length $p1) . $p1;
    $A->send_raw(substr($frame, 0, 2)); select(undef, undef, undef, 0.1);
    $A->send_raw(substr($frame, 2, 5)); select(undef, undef, undef, 0.1);
    $A->send_raw(substr($frame, 7));
    $r = $A->recv('profiles');
    check($r && $r->{requestId} eq 's1', 'frame split across writes (header split too) is reassembled');

    my $pa = $json->encode({ type => 'getProfiles', requestId => 'c1' });
    my $pb = $json->encode({ type => 'getProfiles', requestId => 'c2' });
    $A->send_raw(pack('L', length $pa) . $pa . pack('L', length $pb) . $pb);
    my $m1 = $A->recv('profiles'); my $m2 = $A->recv('profiles');
    check($m1 && $m2 && $m1->{requestId} eq 'c1' && $m2->{requestId} eq 'c2', 'two frames in one write both handled');
}

{    # unicode round trip via profile name
    my $ls = $json->decode(slurp($local_state));
    $ls->{profile}{info_cache}{Default}{name} = "Caf\x{e9} \x{1f600}";
    open my $f, '>', $local_state or die; print $f $json->encode($ls); close $f;
    $r = $A->request({ type => 'getProfiles' });
    my ($d) = grep { $_->{dir} eq 'Default' } @{ $r->{profiles} };
    check($d && $d->{name} eq "Caf\x{e9} \x{1f600}", 'UTF-8 profile names round-trip');
    write_local_state(['Profile 1', 'Default', 'Profile 2']);
}

# ------------------------------------------------------------ 8. replacing an older helper for the same profile
my $B2 = spawn();
$r = $B2->request({ type => 'identify', profileDir => 'Profile 1' });
check($r && $r->{profileDir} eq 'Profile 1', 'new helper identifies as Profile 1');
check(wait_for(sub { $B->exited }, 5), 'older helper for same profile exits on shutdown');
check(-S "$sockdir/Profile_1.sock", 'socket still present (owned by new helper)');
$r = $A->request({ type => 'switchProfile', targetDir => 'Profile 1', bounds => undef });
check($r && $r->{ok} && $r->{method} eq 'focused', 'switch reaches the new helper');
$act = $B2->recv('activate');
check($act && !defined $act->{bounds}, 'null bounds passed through as null', dump_json($act));

# ------------------------------------------------------------ 9. stdin EOF -> socket removed, stdout not held by Chrome
# (fake chrome from step 4 is still sleeping; if it inherited stdout, A's pipe would not hit EOF)
$A->close_stdin;
check(wait_for(sub { $A->exited }, 3), 'stdin EOF: helper process exits');
check(!-e "$sockdir/Default.sock", 'stdin EOF: socket removed');
$A->pump(0.5);
check($A->{eof}, 'launched Chrome did not inherit native-messaging stdout (pipe reached EOF)');

# SIGTERM also removes the socket
$C->kill_it;
check(!-e "$sockdir/Profile_2.sock", 'SIGTERM: socket removed');

# launching with a missing binary reports an error
{
    my $E = Helper->spawn(%ENV_BASE, SIDEBAR_CHROME_BIN => "$tmp/nope");
    push @all, $E;
    $r = $E->request({ type => 'switchProfile', targetDir => 'Default', bounds => undef });
    check($r && !$r->{ok} && $r->{error}, 'missing chrome binary: ok=false with error', dump_json($r));
    check(!-e "$hdir/pending/Default.json", 'missing chrome binary: pending file cleaned up');
    $E->close_stdin;
}

# ------------------------------------------------------------ 10. long path fallback
{
    my $long = "$tmp/" . ('d' x 100);
    my %env = (SIDEBAR_HELPER_DIR => $long);
    my $L1 = Helper->spawn(%ENV_BASE, %env); push @all, $L1;
    my $L2 = Helper->spawn(%ENV_BASE, %env); push @all, $L2;
    my $i1 = $L1->request({ type => 'identify', profileDir => 'Default' });
    my $i2 = $L2->request({ type => 'identify', profileDir => 'Profile 1' });
    check($i1 && $i2 && !$i1->{error} && !$i2->{error}, 'long HELPER_DIR (>104 byte socket path): identify works', dump_json($i1) . dump_json($i2));
    $r = $L1->request({ type => 'switchProfile', targetDir => 'Profile 1', bounds => $bounds });
    check($r && $r->{ok} && $r->{method} eq 'focused', 'long path: switch uses fallback socket');
    $act = $L2->recv('activate');
    check($act && $act->{bounds}{width} == 1200, 'long path: activate delivered');
    $L1->close_stdin; $L2->close_stdin;
    wait_for(sub { $L1->exited && $L2->exited }, 3);
    my @left = glob('/tmp/sbh-*.sock');
    check(!@left, 'long path: fallback sockets cleaned up', "@left");
}

# ------------------------------------------------------------ 13. pictures and styles
{
    $A_alive = spawn();
    $A_alive->request({ type => 'identify', profileDir => 'Default' });
    my $png = "\x89PNG\r\n\x1a\n" . ('x' x 100);
    make_path("$tmp/Default", "$tmp/Profile 1", "$tmp/Profile 2");
    open my $f, '>:raw', "$tmp/Default/Google Profile Picture.png" or die; print $f $png; close $f;
    open $f, '>:raw', "$tmp/Profile 1/Google Profile Picture.png" or die; print $f 'y' x (151 * 1024); close $f;
    $r = $A_alive->request({ type => 'getProfiles' });
    my %q = map { $_->{dir} => $_ } @{ $r->{profiles} // [] };
    my $want = 'data:image/png;base64,' . MIME::Base64::encode_base64($png, '');
    check(($q{Default}{picture} // '') eq $want, 'picture: data URL for profile with picture file', substr($q{Default}{picture} // 'undef', 0, 40));
    check(exists $q{'Profile 2'}{picture} && !defined $q{'Profile 2'}{picture}, 'picture: null for profile without file');
    check(!defined $q{'Profile 1'}{picture}, 'picture: oversized (>150 KB) file skipped');
    check(!defined $q{Default}{style} && exists $q{Default}{style}, 'style: null by default');

    # gaia_picture_file_name honoured
    my $ls = $json->decode(slurp($local_state));
    $ls->{profile}{info_cache}{'Profile 2'}{gaia_picture_file_name} = 'custom.png';
    open $f, '>', $local_state or die; print $f $json->encode($ls); close $f;
    open $f, '>:raw', "$tmp/Profile 2/custom.png" or die; print $f $png; close $f;
    $r = $A_alive->request({ type => 'getProfiles' });
    my ($p2) = grep { $_->{dir} eq 'Profile 2' } @{ $r->{profiles} };
    check($p2 && ($p2->{picture} // '') eq $want, 'picture: gaia_picture_file_name honoured');
    write_local_state(['Profile 1', 'Default', 'Profile 2']);

    # setProfileStyle
    $r = $A_alive->request({ type => 'setProfileStyle', dir => 'Profile 2', style => { icon => 'rocket', color => '#FF5f57' }, requestId => 'st1' });
    my ($p2b) = grep { $_->{dir} eq 'Profile 2' } @{ $r->{profiles} // [] };
    check($r && $r->{requestId} eq 'st1' && !$r->{error} && $p2b && $p2b->{style}{icon} eq 'rocket' && $p2b->{style}{color} =~ /^#ff5f57$/i,
          'setProfileStyle: reply has fresh profiles with style', dump_json($r && $p2b));
    my $stj = eval { $json->decode(slurp("$hdir/state.json")) } || {};
    check($stj->{profileStyles}{'Profile 2'}{icon} eq 'rocket', 'setProfileStyle: persisted under profileStyles', slurp("$hdir/state.json"));
    check(($stj->{archiveDefaultMinutes} // -1) == 720, 'setProfileStyle: other state keys preserved');
    my $bm = $B2->recv('profiles');
    my ($p2c) = grep { $_->{dir} eq 'Profile 2' } @{ $bm->{profiles} // [] };
    check($bm && $p2c && $p2c->{style}{icon} eq 'rocket', 'setProfileStyle: other helper forwards {type:profiles} to its extension', dump_json($bm));
    check($A_alive->quiet_for(0.3), 'setProfileStyle: sender gets no unsolicited profiles');

    my $n0 = slurp("$hdir/state.json");
    for my $bad (
        ['bad icon',   { icon => 'skull', color => '#ff5f57' }],
        ['bad colour', { icon => 'star',  color => 'red' }],
        ['short hex',  { icon => 'star',  color => '#fff' }],
        ['no colour',  { icon => 'star' }],
        ['non-object', 'star'],
    ) {
        $r = $A_alive->request({ type => 'setProfileStyle', dir => 'Default', style => $bad->[1] });
        check($r && $r->{type} eq 'profiles' && $r->{error}, "setProfileStyle: rejects $bad->[0]", dump_json($r && $r->{error}));
    }
    $r = $A_alive->request({ type => 'setProfileStyle', dir => 'Nope', style => { icon => 'star', color => '#000000' } });
    check($r && $r->{error}, 'setProfileStyle: rejects unknown profile');
    check(slurp("$hdir/state.json") eq $n0, 'setProfileStyle: rejected requests do not change state');
    check($B2->quiet_for(0.3), 'setProfileStyle: rejected requests are not broadcast');

    $r = $A_alive->request({ type => 'setProfileStyle', dir => 'Profile 2', style => undef });
    ($p2b) = grep { $_->{dir} eq 'Profile 2' } @{ $r->{profiles} // [] };
    check($r && !$r->{error} && !defined $p2b->{style}, 'setProfileStyle null: clears style');
    $stj = eval { $json->decode(slurp("$hdir/state.json")) } || {};
    check(!exists $stj->{profileStyles}{'Profile 2'}, 'setProfileStyle null: removed from state.json');
    $bm = $B2->recv('profiles');
    check($bm, 'setProfileStyle null: broadcast');

    # 900 KB cap: five 140 KB pictures (~187 KB each as base64) plus extras
    my $big = "$tmp/big"; make_path($big);
    my %ic;
    for my $i (1 .. 6) {
        make_path("$big/P$i");
        open my $pf, '>:raw', "$big/P$i/Google Profile Picture.png" or die;
        print $pf 'z' x ((120 + $i * 3) * 1024); close $pf;
        $ic{"P$i"} = { name => "P$i" };
    }
    open my $lf, '>', "$big/Local State" or die; print $lf $json->encode({ profile => { info_cache => \%ic } }); close $lf;
    my $G = Helper->spawn(%ENV_BASE, SIDEBAR_LOCAL_STATE => "$big/Local State"); push @all, $G;
    $G->send({ type => 'hello' });
    my $h = $G->recv('hello');
    my @pics = grep { defined $_->{picture} } @{ $h->{profiles} // [] };
    my $enc = length $json->encode($h);
    check($h && @{ $h->{profiles} } == 6, 'cap: all 6 profiles still listed');
    check($enc < 900 * 1000, "cap: hello reply under 900 KB ($enc bytes)");
    check(@pics > 0 && @pics < 6, 'cap: some pictures dropped, not all', scalar @pics);
    my %kept = map { $_->{dir} => 1 } @pics;
    check(!$kept{P6} && $kept{P1}, 'cap: largest pictures dropped first', join(',', sort keys %kept));
    $G->close_stdin;
    $A_alive->close_stdin;
}

# ------------------------------------------------------------ 14. relay to the Mac app
{
    my $rdir = "$tmp/relay";
    make_path($rdir);
    my $opath = "$rdir/overlay.sock";
    my $H = Helper->spawn(%ENV_BASE, SIDEBAR_HELPER_DIR => $rdir); push @all, $H;

    # helper started before the app exists; must not connect before identify, and stay responsive
    my $app = FakeApp->listen($opath);
    check(!$app->accept(1.2), 'relay: no connection before identify');
    $r = $H->request({ type => 'identify', profileDir => 'Default' });
    check($r && $r->{profileDir} eq 'Default', 'relay: identify ok');
    check($app->accept(2), 'relay: connects to overlay socket after identify');
    my $ph = $app->recv('profileHello');
    check($ph && $ph->{profileDir} eq 'Default' && ref $ph->{profiles} eq 'ARRAY' && @{ $ph->{profiles} } == 3,
          'relay: profileHello on connect (profileDir + profiles)', dump_json($ph));
    my $os = $H->recv('overlayStatus');
    check($os && $os->{connected}, 'relay: extension told overlayStatus connected:true', dump_json($os));

    # toExt -> extension
    my $bm = { type => 'bridge', id => 'b1', call => 'tabs.query', args => [{ active => JSON::PP::true }], note => "caf\x{e9} \x{1f600}" };
    $app->send({ type => 'toExt', msg => $bm });
    my $got = $H->recv('bridge');
    check($got && dump_json($got) eq dump_json($bm), 'relay: toExt msg delivered to extension as framed message', dump_json($got));

    # partial lines, coalesced lines, garbage lines
    {
        my $l = $json->encode({ type => 'toExt', msg => { type => 'bridge', id => 'p1', call => 'x', args => [] } }) . "\n";
        $app->send_raw(substr($l, 0, 7)); select(undef, undef, undef, 0.2);
        check($H->quiet_for(0.1), 'relay: partial line not delivered early');
        $app->send_raw(substr($l, 7, 10)); select(undef, undef, undef, 0.2);
        $app->send_raw(substr($l, 17));
        $got = $H->recv('bridge');
        check($got && $got->{id} eq 'p1', 'relay: line split across writes reassembled');
        my $a = $json->encode({ type => 'toExt', msg => { type => 'bridge', id => 'c1', call => 'x', args => [] } }) . "\n";
        my $b = $json->encode({ type => 'toExt', msg => { type => 'bridge', id => 'c2', call => 'x', args => [] } }) . "\n";
        $app->send_raw("not json\n\n" . $json->encode({ type => 'weird' }) . "\n" . '[1,2]' . "\n" . $a . $b);
        my $g1 = $H->recv('bridge'); my $g2 = $H->recv('bridge');
        check($g1 && $g2 && $g1->{id} eq 'c1' && $g2->{id} eq 'c2', 'relay: coalesced lines handled in order, garbage ignored');
        $r = $H->request({ type => 'getProfiles', requestId => 'alive1' });
        check($r && $r->{requestId} eq 'alive1', 'relay: helper alive after garbage from app');
        check($app->quiet_for(0.2), 'relay: unchanged getProfiles does not resend profileHello');
    }

    # large lines (~1 MB) both directions
    {
        my $blob = 'q' x (1000 * 1000);
        $app->send({ type => 'toExt', msg => { type => 'bridge', id => 'big', call => 'x', args => [$blob] } }, sub { $H->pump(0) });
        $got = $H->recv('bridge', 10);
        check($got && length($got->{args}[0]) == length $blob, 'relay: 1 MB toExt line delivered', $got ? length($got->{args}[0]) : 'undef');
        $H->send({ type => 'bridgeResult', id => 'bigr', ok => JSON::PP::true, result => $blob });
        my $f = $app->recv('fromExt', 10);
        check($f && length($f->{msg}{result}) == length $blob && $f->{msg}{id} eq 'bigr', 'relay: 1 MB fromExt line delivered to app');
    }

    # extension -> app
    my $res = { type => 'bridgeResult', id => 'b1', ok => JSON::PP::true, result => [{ id => 5, title => "t\x{e9}" }] };
    $H->send($res);
    my $f = $app->recv('fromExt');
    check($f && $f->{profileDir} eq 'Default' && dump_json($f->{msg}) eq dump_json($res), 'relay: bridgeResult -> fromExt{profileDir,msg}', dump_json($f));
    my $ev = { type => 'bridgeEvent', name => 'tabs.onCreated', args => [{ id => 9 }] };
    $H->send($ev);
    $f = $app->recv('fromExt');
    check($f && $f->{profileDir} eq 'Default' && dump_json($f->{msg}) eq dump_json($ev), 'relay: bridgeEvent -> fromExt{profileDir,msg}', dump_json($f));

    # unrelated messages are not forwarded
    $H->send({ type => 'getProfiles', requestId => 'u1' });
    $H->send({ type => 'bogus' });
    $H->send({ type => 'hello' });
    $H->send({ type => 'bridge', id => 'nope', call => 'x', args => [] });
    $H->send({ type => 'overlayStatus', connected => JSON::PP::true });
    $H->recv('profiles'); $H->recv('hello');
    check($app->quiet_for(0.5), 'relay: unrelated extension messages are NOT forwarded', dump_json($app->{lines}));
    $H->{msgs} = [];

    # bridge messages with the app stalled: helper stays responsive, data arrives later in order
    {
        my $chunk = 'e' x (100 * 1024);
        $H->send({ type => 'bridgeEvent', name => 'e', args => [$_, $chunk] }) for 1 .. 20;
        $r = $H->request({ type => 'getProfiles', requestId => 'alive2' });
        check($r && $r->{requestId} eq 'alive2', 'relay: helper responsive while app is not reading');
        my @seq;
        while (@seq < 20) { my $m = $app->recv('fromExt', 5) or last; push @seq, $m->{msg}{args}[0]; }
        check(join(',', @seq) eq join(',', 1 .. 20), 'relay: backlog delivered in order once app reads', join(',', @seq));
    }

    # identify again with another profile / style change -> new profileHello
    $r = $H->request({ type => 'identify', profileDir => 'Profile 1' });
    $ph = $app->recv('profileHello');
    check($ph && $ph->{profileDir} eq 'Profile 1', 'relay: profileHello again after identify (new profileDir)', dump_json($ph && $ph->{profileDir}));
    $H->send($ev);
    $f = $app->recv('fromExt');
    check($f && $f->{profileDir} eq 'Profile 1', 'relay: fromExt uses the new profileDir');
    $H->request({ type => 'setProfileStyle', dir => 'Profile 2', style => { icon => 'star', color => '#123456' } });
    $ph = $app->recv('profileHello');
    my ($p2) = grep { $_->{dir} eq 'Profile 2' } @{ $ph ? $ph->{profiles} : [] };
    check($ph && $p2 && $p2->{style} && $p2->{style}{icon} eq 'star', 'relay: profileHello after profile list change', dump_json($p2));
    $H->request({ type => 'setProfileStyle', dir => 'Profile 2', style => undef });
    $app->recv('profileHello');
    $H->{msgs} = [];

    # app closes the connection (listener stays): disconnect noticed, reconnect within retry window
    $app->drop_conn;
    $os = $H->recv('overlayStatus');
    check($os && defined $os->{connected} && !$os->{connected}, 'relay: overlayStatus connected:false when app drops connection', dump_json($os));
    $H->send($ev);    # must not die / block with no app
    $r = $H->request({ type => 'getProfiles', requestId => 'alive3' });
    check($r && $r->{requestId} eq 'alive3', 'relay: helper alive and responsive with app gone');
    check(!$H->exited, 'relay: helper still running');
    check($app->accept(6), 'relay: reconnects after connection drop (retry)');
    $ph = $app->recv('profileHello');
    check($ph && $ph->{profileDir} eq 'Profile 1', 'relay: profileHello re-sent on reconnect');
    $os = $H->recv('overlayStatus');
    check($os && $os->{connected}, 'relay: overlayStatus true after reconnect');
    check($app->quiet_for(0.2) && !grep({ $_->{type} eq 'fromExt' } @{ $app->{lines} }), 'relay: events sent while disconnected are not replayed');

    # app restarts completely (listener gone, socket file removed, then recreated)
    $app->stop;
    $os = $H->recv('overlayStatus');
    check($os && !$os->{connected}, 'relay: overlayStatus false when app quits');
    select(undef, undef, undef, 1.5);
    $r = $H->request({ type => 'getProfiles', requestId => 'alive4' });
    check($r && $r->{requestId} eq 'alive4', 'relay: helper responsive while app absent');
    $app = FakeApp->listen($opath);
    check($app->accept(6), 'relay: reconnects after app restart');
    $ph = $app->recv('profileHello');
    check($ph && $ph->{profileDir} eq 'Profile 1', 'relay: profileHello after app restart');
    $os = $H->recv('overlayStatus');
    check($os && $os->{connected}, 'relay: overlayStatus true after app restart');
    $app->send({ type => 'toExt', msg => { type => 'bridge', id => 'after', call => 'x', args => [] } });
    $got = $H->recv('bridge');
    check($got && $got->{id} eq 'after', 'relay: toExt works after restart');

    # helper exit while connected closes cleanly
    $H->close_stdin;
    check(wait_for(sub { $H->exited }, 3), 'relay: helper exits on stdin EOF while connected');
    $app->pump(0.3);
    check($app->{eof}, 'relay: app sees connection closed when helper exits');
    $app->stop;

    # long HELPER_DIR: fallback path /tmp/sbh-<uid>-<md5 of "<dir>\0overlay">.sock
    {
        my $long = "$tmp/" . ('o' x 100);
        make_path($long);
        my $fp = "/tmp/sbh-$<-" . substr(md5_hex("$long\0overlay"), 0, 12) . '.sock';
        my $la = FakeApp->listen($fp);
        my $L = Helper->spawn(%ENV_BASE, SIDEBAR_HELPER_DIR => $long); push @all, $L;
        $L->request({ type => 'identify', profileDir => 'Default' });
        check($la->accept(3), 'relay: long HELPER_DIR uses /tmp fallback overlay socket');
        $L->close_stdin;
        wait_for(sub { $L->exited }, 3);
        $la->stop;
    }
}

# ------------------------------------------------------------ 11. log file, quiet stdout
check(-s "$hdir/helper.log", 'helper.log written');
check(slurp("$hdir/helper.log") =~ /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /m, 'helper.log lines are timestamped');

# ------------------------------------------------------------ 12. install/uninstall scripts (HOME sandbox)
{
    my $home = "$tmp/home";
    make_path($home);
    my $dir = dirname($HELPER);
    my $run = sub { system("HOME='$home' bash '$dir/$_[0]' >'$tmp/$_[0].out' 2>&1") == 0 };
    SKIP: {
        if (!-x '/usr/bin/perl') { print "SKIP  install.sh (no /usr/bin/perl)\n"; last SKIP; }
        check($run->('install.sh'), 'install.sh succeeds', slurp("$tmp/install.sh.out"));
        check($run->('install.sh'), 'install.sh is idempotent');
        my $mf = "$home/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sidebar.helper.json";
        my $m = eval { $json->decode(slurp($mf)) } || {};
        check($m->{name} eq 'com.sidebar.helper' && $m->{type} eq 'stdio'
              && $m->{path} eq "$home/Library/Application Support/SidebarHelper/sidebar-helper.pl"
              && -x $m->{path}
              && $m->{allowed_origins}[0] eq 'chrome-extension://ffblekellgdmlecjablfojaaadpkmdgg/',
              'installed manifest is valid JSON with substituted path', slurp($mf));
        check($run->('uninstall.sh') && !-e $mf && !-e $m->{path}, 'uninstall.sh removes manifest and helper');
        check($run->('uninstall.sh'), 'uninstall.sh is idempotent');
    }
}

# ------------------------------------------------------------ cleanup
$_->kill_it for grep { !$_->{done} } @all;

print "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
