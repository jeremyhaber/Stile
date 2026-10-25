// All the fake seed data for the demo GIFs. Everything here is fictional: generic site names on reserved ".test" hosts,
// placeholder text, made-up file names. Add a site, a pinned folder, an archive entry or a download by editing this file.
// Never put real browsing data, names, emails or file names here.

// key -> a fictional site. `host` is mapped to the local fake server; `letter` and `color` make its favicon.
export const SITES = {
  encyclopedia: { title: 'Encyclopedia', host: 'encyclopedia.test', color: '#4b5563', letter: 'E', head: 'Octopus', bg: '#ffffff' },
  docs: { title: 'Dev Docs', host: 'docs.test', color: '#1b6ac9', letter: 'D', head: 'Array methods', bg: '#ffffff' },
  news: { title: 'Daily News', host: 'news.test', color: '#ff6600', letter: 'N', head: 'Top stories', bg: '#f6f6ef' },
  code: { title: 'Code Hub', host: 'code.test', color: '#24292f', letter: 'H', head: 'Pull requests', bg: '#ffffff' },
  weather: { title: 'Weather', host: 'weather.test', color: '#0ea5e9', letter: 'W', head: 'This week', bg: '#eaf6fd' },
  recipes: { title: 'Recipes', host: 'recipes.test', color: '#e11d48', letter: 'R', head: 'Weeknight pasta', bg: '#fff8f6' },
  calendar: { title: 'Calendar', host: 'calendar.test', color: '#16a34a', letter: 'C', head: 'October', bg: '#ffffff' },
  maps: { title: 'Maps', host: 'maps.test', color: '#9333ea', letter: 'M', head: 'Directions', bg: '#f3eefb' },
  notes: { title: 'Notes', host: 'notes.test', color: '#ca8a04', letter: 'N', head: 'Meeting notes', bg: '#fffbea' },
  music: { title: 'Music', host: 'music.test', color: '#db2777', letter: 'M', head: 'Listen now', bg: '#ffffff' },
};

// Tabs open in the demo window, by scene need.
export const TABS = {
  standard: ['encyclopedia', 'docs', 'news', 'code', 'weather', 'recipes', 'calendar', 'maps'],
};

// Favourites tiles and pinned folders (site keys). Scenes pin these before recording.
export const FAVOURITES = ['weather', 'calendar'];
export const PINNED_FOLDERS = { Work: ['code'], Reading: [] };

// A coloured tab group.
export const GROUP = { title: 'Research', color: 'blue', sites: ['docs', 'code', 'news'] };

// Archive entries: [site key, title, hours ago, url path]
export const ARCHIVE = [
  ['recipes', 'Weeknight pasta', 2, 'pasta'], ['news', 'Daily News', 5, ''], ['music', 'Music', 9, ''], ['notes', 'Meeting notes', 14, ''],
  ['calendar', 'Calendar', 30, ''], ['docs', 'Array methods - Dev Docs', 52, 'array'], ['encyclopedia', 'Octopus - Encyclopedia', 76, 'octopus'],
];
export const ARCHIVE_SEARCH = 'pasta';

// Extra tabs for the Tidy scene: [site key, url path] (several per site so Tidy has something to group).
export const TIDY_EXTRA = [['encyclopedia', 'octopus'], ['docs', 'array'], ['encyclopedia', 'squid'], ['docs', 'fetch'], ['code', 'issues']];

// Downloads: three finished files and one that streams in. Sizes in bytes (content is zeros).
// `dir` is the fake folder shown in the UI; it deliberately contains no user name.
export const DOWNLOAD_DIR = '/Downloads/';
export const DOWNLOADS = {
  done: [{ name: 'Quarterly report.pdf', size: 9500 }, { name: 'Team photo.jpg', size: 7100 }, { name: 'Notes.txt', size: 5100 }],
  slow: { name: 'Design assets.zip', size: 600000 },
};

// Zap: elements hidden on the "news" site (CSS selectors in the fake page).
export const ZAP_TARGETS = ['#promo', '.card'];

// Custom CSS typed into the Boost editor.
export const BOOST_CSS = 'body { background: #1c1917; color: #e7e5e4 }\nh1 { color: #fb923c }\n.card { background: #44403c }';

// Capture scene: the screenshot is a synthetic fake page (the "weather" site), never the real screen.
export const CAPTURE = { site: 'weather', note: 'Remove this' };

// Little windows scene: the link "another app" hands to the browser (site key + URL path), and the tab shown behind it.
export const LITTLE = { site: 'recipes', path: 'pasta', behind: 'news', second: { site: 'notes', path: 'list' } };

// The mock "other app" in the Little windows scene: a plain chat (no brand) whose two messages hold the two links above.
// `label` is only the text shown for the link; the scene opens LITTLE.site/path and LITTLE.second.site/path.
export const LITTLE_APP = {
  title: 'Messages', contact: 'Sam',
  messages: [
    { text: 'Have you seen this recipe?', link: { label: 'recipes.test/pasta' } },
    { text: 'And the list for Saturday:', link: { label: 'notes.test/list' } },
  ],
};
