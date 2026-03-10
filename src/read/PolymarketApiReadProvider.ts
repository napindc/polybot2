import type { PolymarketReadProvider } from './PolymarketReadService';
import type { Market, MarketId, Outcome } from '../types';
import { callAI as callGemini, hasAIKeys as hasGeminiKeys } from './aiClient';
import { getOrFetch } from '../storage/redisClient';

/**
 * Base URL for the Polymarket Gamma API (market metadata).
 * This is the public, unauthenticated endpoint for reading market data.
 */
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

/**
 * Maximum number of markets to fetch per list/search request.
 */
const DEFAULT_PAGE_LIMIT = 50;
const SEARCH_PAGE_LIMIT = 200;
const MAX_SEARCH_PAGES = 25; // safety cap to avoid unbounded requests

/**
 * Sports metadata cache — the /sports list rarely changes.
 */
interface SportEntry {
	readonly id: number;
	readonly sport: string;
	readonly tags: string; // comma-separated tag IDs, e.g. "1,64,65,100639"
	readonly series: string;
}

let sportsCache: SportEntry[] | null = null;
let sportsCacheExpiresAt = 0;
const SPORTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Aliases that map common user terms to Gamma API sport codes.
 * The /sports endpoint uses short codes (e.g. "lol", "nba", "cs2").
 */
const SPORT_ALIASES: Record<string, string[]> = {
	// Esports
	lol: ['league of legends', 'lol', 'lck', 'lpl', 'lec', 'lcs', 'worlds', 'msi',
		// LCK teams
		'kt rolster', 'kt', 'ktc', 'drx', 'drxc', 't1', 'gen.g', 'geng', 'gen g',
		'hanwha', 'hle', 'dplus', 'dk', 'dplus kia', 'bnk', 'fearx', 'bnk fearx',
		'brion', 'bro', 'freecs', 'dnf', 'nongshim', 'ns', 'ns redforce', 'redforce',
		// LPL teams
		'jdg', 'jd gaming', 'blg', 'bilibili', 'weibo', 'wbg', 'al', "anyone's legend",
		'anyones legend', 'tes', 'top esports', 'we', 'team we', 'ig', 'invictus',
		'nip', 'ninjas in pyjamas', 'ra', 'royal academy', 'lng', 'edg', 'rng',
		'fpx', 'funplus', 'jdg', 'omg', 'nv', 'team nv',
		// LCP teams
		'cfo', 'ctbc', 'flying oyster', 'tsw', 'team secret whales', 'dcg', 'deep cross',
		'gz', 'ground zero', 'shg', 'softbank hawks',
		// LCS (NA) teams
		'c9', 'cloud9', 'tl', 'team liquid', 'fly', 'flyquest', '100t', '100 thieves',
		'eg', 'evil geniuses', 'nrg', 'dignitas', 'immortals', 'shopify rebellion', 'shopify',
		// LEC (EU) teams
		'g2', 'g2 esports', 'fnatic', 'excel', 'xls', 'sk gaming', 'sk',
		'misfits', 'rogue', 'mad lions', 'mad', 'astralis', 'vitality', 'team vitality',
		'heretics', 'giantx', 'karmine corp', 'karmine', 'kcorp',
		// ERL / Academy sub-league teams (LoL-specific)
		'nord', 'nordguard', 'g2 nord', 'use1', 'use2',
		'lyon', 'ldlc', 'rwc', 'bbl esports', 'bbl',
		'unicorns of love', 'uol', 'team bds', 'bds', 'movistar', 'natus vincere', 'navi'],
	cs2: ['counter strike', 'counter-strike', 'cs2', 'csgo', 'cs go', 'cs:go', 'hltv',
		'navi', 'faze', 'vitality', 'g2 esports', 'g2 ares', 'g2a', 'astralis', 'cloud9', 'mouz', 'spirit',
		'heroic', 'ence', 'liquid', 'complexity', 'fnatic', 'big', 'nip', 'virtus.pro',
		// WW Team (ESL Challenger / regional CS2 team)
		'ww team', 'ww', 'wwteam',
		// ESL/BLAST teams
		'3dmax', '3 dmax', 'gaimin', 'gaimin gladiators', 'saw', 'passion ua',
		'furia', 'mibr', 'imperial', 'monte', 'betboom', 'forze', 'aurora',
		'eternfire', 'spirit cs', 'team vitality', 'team liquid'],
	dota2: ['dota', 'dota2', 'dota 2', 'the international',
		// Major Dota 2 teams
		'tundra', 'tundra esports', 'betboom', 'og', 'team spirit', 'spirit',
		'gaimin', 'gaimin gladiators', 'entity', 'beastcoast', 'nine pandas',
		'talon esports', 'talon', 'shopify rebellion', 'shopify', 'azure ray',
		'xtreme gaming', 'lgd', 'psg lgd', 'ehome', 'vici', 'vici gaming',
		'newbee', 'alliance', 'boom esports', 'boom', 'blacklist', 'execration',
		'1win', 'yakutou', 'team yandex', 'soniqs', 'wildcard', 'hokori',
		'virtus.pro', 'natus vincere', 'navi'],
	val: ['valorant', 'vct', 'val', 'sentinels', 'loud', 'paper rex', 'prx', 'nrg',
		'team heretics', 'heretics', 'leviatán', 'mibr', 'bleed', 'trace', 'optic'],
	mlbb: ['mobile legends', 'mlbb'],
	ow: ['overwatch', 'overwatch 2', 'ow2'],
	codmw: ['call of duty', 'cod', 'warzone'],
	rl: ['rocket league'],
	sc2: ['starcraft', 'starcraft 2', 'sc2'],
	sc: ['brood war', 'starcraft brood'],
	pubg: ['pubg', 'playerunknown'],
	r6siege: ['rainbow six', 'r6', 'r6 siege', 'siege'],
	wildrift: ['wild rift', 'wildrift', 'lol mobile'],
	psp: ['esports', 'gaming tournament'],
	// Traditional sports
	nba: ['nba', 'basketball', 'lakers', 'celtics', 'warriors', 'warrior', 'bucks', 'nets', 'knicks',
		'clippers', 'clipper', 'nuggets', 'heat', 'bulls', 'suns', 'spurs', 'pistons',
		'raptors', 'hawks', 'thunder', 'trail blazers', 'blazers', 'pacers', 'cavaliers',
		'wizards', 'pelicans', 'jazz', 'kings', 'grizzlies', 'rockets', 'magic', 'hornets',
		'76ers', 'sixers', 'mavericks', 'mavs', 'timberwolves', 'wolves',
		// Player names — enables tag-based search for player prop queries
		'wembanyama', 'tatum', 'jayson tatum', 'victor wembanyama',
		'lebron', 'lebron james', 'curry', 'steph curry', 'stephen curry',
		'giannis', 'jokic', 'nikola jokic', 'luka', 'luka doncic',
		'kyrie', 'kyrie irving', 'dame', 'lillard', 'damian lillard',
		'durant', 'kevin durant', 'harden', 'james harden', 'booker', 'devin booker',
		'embiid', 'joel embiid', 'shai', 'gilgeous-alexander',
	],
	// WNBA — use full city+team names to avoid ambiguous single words ('sun' → Sunderland, 'storm' → weather, etc.)
	wnba: ['wnba', 'womens basketball', "women's nba", "women's basketball",
		'connecticut sun', 'las vegas aces', 'indiana fever', 'washington mystics',
		'seattle storm', 'los angeles sparks', 'new york liberty', 'dallas wings',
		'chicago sky', 'atlanta dream', 'minnesota lynx', 'phoenix mercury'],
	nfl: ['nfl', 'football', 'super bowl', 'superbowl', 'patriots', 'chiefs', 'eagles', 'nfl draft', 'draft pick', 'first overall pick'],
	mlb: ['mlb', 'baseball', 'world series', 'yankees', 'dodgers', 'mets'],
	nhl: ['nhl', 'hockey', 'stanley cup',
		// NHL team names — all 32 teams
		'boston bruins', 'buffalo sabres', 'detroit red wings', 'florida panthers',
		'montreal canadiens', 'canadiens', 'habs', 'ottawa senators', 'tampa bay lightning',
		'toronto maple leafs', 'maple leafs', 'carolina hurricanes', 'columbus blue jackets',
		'new jersey devils', 'new york islanders', 'new york rangers', 'philadelphia flyers',
		'pittsburgh penguins', 'washington capitals', 'arizona coyotes', 'chicago blackhawks',
		'colorado avalanche', 'avalanche', 'dallas stars', 'minnesota wild', 'nashville predators',
		'st louis blues', 'winnipeg jets', 'anaheim ducks', 'calgary flames',
		'edmonton oilers', 'oilers', 'los angeles kings', 'san jose sharks',
		'seattle kraken', 'vancouver canucks', 'vegas golden knights', 'golden knights',
		'utah hockey club'],
	// Hockey variants
	khl: ['khl', 'kontinental hockey', 'russian hockey', 'kontinental league'],
	shl: ['shl', 'swedish hockey league', 'sweden hockey'],
	cehl: ['czech extraliga', 'czech hockey', 'cehl'],
	dehl: ['del', 'deutsche eishockey liga', 'german hockey', 'dehl'],
	snhl: ['national league hockey', 'swiss hockey', 'snhl', 'nl hockey switzerland'],
	ahl: ['ahl', 'american hockey league', 'ahl hockey',
		// AHL team names — enables detection from team-based queries like "Providence Bruins vs Bridgeport Islanders"
		'providence bruins', 'bridgeport islanders', 'hershey bears', 'hartford wolf pack',
		'charlotte checkers', 'lehigh valley phantoms', 'springfield thunderbirds',
		'syracuse crunch', 'utica comets', 'belleville senators', 'rochester americans',
		'toronto marlies', 'manitoba moose', 'cleveland monsters', 'wilkes-barre scranton penguins',
		'texas stars', 'chicago wolves', 'rockford icehogs', 'grand rapids griffins',
		'milwaukee admirals', 'iowa wild', 'san jose barracuda', 'san diego gulls',
		'tucson roadrunners', 'bakersfield condors', 'colorado eagles', 'abbotsford canucks',
		'ontario reign', 'henderson silver knights', 'coachella valley firebirds',
		'calgary wranglers', 'laval rocket', 'manitoba moose'],
	hok: ['field hockey', 'field hockey championship'],
	epl: ['premier league', 'epl',
		// Big 6 + common full/short names
		'manchester united', 'man united', 'man utd', 'mufc',
		'manchester city', 'man city', 'mcfc',
		'arsenal', 'afc', 'the gunners',
		'chelsea', 'cfc', 'the blues',
		'liverpool', 'lfc', 'the reds',
		'tottenham', 'spurs', 'thfc',
		// Others
		'aston villa', 'villa', 'avfc',
		'newcastle', 'newcastle united', 'nufc', 'magpies',
		'west ham', 'west ham united', 'whufc', 'hammers',
		'brighton', 'brighton hove albion', 'bhafc', 'seagulls',
		'brentford', 'bfc', 'bees',
		'crystal palace', 'palace', 'cpfc', 'eagles',
		'fulham', 'ffc', 'cottagers',
		'wolves', 'wolverhampton', 'wwfc',
		'nottingham forest', 'forest', 'nffc',
		'bournemouth', 'afcb', 'cherries',
		'everton', 'efc', 'toffees',
		'leicester', 'leicester city', 'lcfc', 'foxes',
		'ipswich', 'ipswich town', 'itfc', 'tractor boys',
		'southampton', 'saints', 'sfc'],
	lal: ['la liga', 'laliga',
		'barcelona', 'fc barcelona', 'barca',
		'real madrid', 'cf', 'madrid',
		'atletico madrid', 'atletico', 'atleti',
		'sevilla', 'sfc',
		'real sociedad', 'sociedad',
		'villarreal', 'yellow submarine',
		'athletic bilbao', 'athletic club', 'bilbao',
		'real betis', 'betis',
		'valencia', 'vfc',
		'osasuna', 'girona', 'mallorca', 'celta vigo', 'celta',
		'getafe', 'rayo vallecano', 'rayo', 'vegas',
		'deportivo alaves', 'alaves', 'leganes'],
	bun: ['bundesliga',
		'bayern munich', 'fc bayern', 'fcb', 'fcbayern',
		'borussia dortmund', 'dortmund', 'bvb',
		'bayer leverkusen', 'leverkusen', 'b04',
		'rb leipzig', 'rasenball', 'leipzig',
		'borussia monchengladbach', 'monchengladbach', 'gladbach', 'bmo',
		'eintracht frankfurt', 'frankfurt', 'sge',
		'vfb stuttgart', 'stuttgart', 'vfb',
		'sc freiburg', 'freiburg', 'scf',
		'wolfsburg', 'vfl wolfsburg',
		'union berlin', 'fc union', 'union',
		'werder bremen', 'werder', 'svw',
		'hoffenheim', 'tsg hoffenheim',
		'fc augsburg', 'augsburg', 'fca',
		'mainz', 'fsv mainz',
		'heidenheim', 'holstein kiel', 'bochum', 'vfl bochum',
		'fc koln', 'koln', 'cologne', 'fc nurnberg', 'nurnberg',
		'hamburger sv', 'hsv', 'hamburger', 'hamburger sv'],
	sea: ['serie a',
		'juventus', 'juve',
		'inter milan', 'inter', 'internazionale', 'nerazzurri',
		'ac milan', 'milan', 'rossoneri',
		'napoli', 'ssc napoli', 'partenopei',
		'as roma', 'roma', 'giallorossi',
		'lazio', 'ss lazio',
		'atalanta', 'dea',
		'fiorentina', 'viola',
		'torino', 'granata',
		'bologna', 'fc bologna',
		'udinese', 'verona', 'hellas verona',
		'sampdoria', 'samp',
		'cagliari', 'genoa', 'empoli', 'lecce', 'salernitana',
		'parma', 'venezia', 'monza', 'como'],
	ucl: ['champions league', 'ucl', 'uefa champions'],
	uel: ['europa league', 'uel'],
	mls: ['mls', 'major league soccer'],
	ipl: ['ipl', 'indian premier league', 'cricket', 'odi', 't20', 'test match',
		'australia', 'aus', 'india', 'ind', 'england', 'eng', 'south africa', 'sa',
		'new zealand', 'nz', 'pakistan', 'pak', 'sri lanka', 'sl', 'west indies', 'wi',
		'bangladesh', 'ban', 'afghanistan', 'afg'],
	// Cricket series/tournament codes
	odi: ['one day cricket', 'odi cricket', 'one day international'],
	t20: ['t20 cricket', 't20i', 'twenty20', 'twenty 20'],
	test: ['test cricket', 'test match cricket', 'test series'],
	cricipl: ['ipl 2026', 'indian premier league 2026'],
	cricpsl: ['psl cricket', 'pakistan super league', 'psl'],
	criccpl: ['cpl cricket', 'caribbean premier league'],
	cricbbl: ['big bash league', 'bbl cricket', 'big bash'],
	crict20blast: ['t20 blast', 'vitality blast', 'county cricket'],
	cricmlc: ['major league cricket', 'mlc cricket', 'usa cricket'],
	cricilt20: ['ilt20', 'uae cricket league'],
	// Cricket country series
	craus: ['australia cricket series', 'cricket australia'],
	creng: ['england cricket series', 'ecb cricket'],
	crind: ['india cricket series', 'bcci cricket'],
	crpak: ['pakistan cricket series', 'pcb cricket'],
	crnew: ['new zealand cricket series', 'blackcaps'],
	crsou: ['south africa cricket', 'proteas cricket'],
	ufc: ['ufc', 'mma', 'mixed martial arts', 'ultimate fighting'],
	zuffa: ['zuffa', 'ufc fight night', 'bellator', 'one championship'],
	atp: ['atp', 'tennis', 'djokovic', 'nadal', 'federer', 'alcaraz', 'sinner'],
	wta: ['wta', 'women tennis'],
	ncaab: ['march madness', 'ncaa basketball', 'ncaab', 'college basketball', 'ncaa', 'tournament', 'ncaa tournament', 'ncaa mens', 'ncaa womens', 'final four'],
	cfb: ['college football', 'cfb', 'ncaa football'],
	kbo: ['kbo', 'korean baseball'],
	// Rugby
	ruprem: ['rugby', 'rugby union', 'rugby league', 'premiership rugby', 'aviva premiership'],
	rutopft: ['top 14', 'top14', 'french rugby', 'pro14'],
	rusixnat: ['six nations', '6 nations', 'rugby six nations'],
	ruurc: ['united rugby', 'urc', 'rainbow cup', 'united rugby championship'],
	rusrp: ['super rugby', 'super rugby pacific', 'srp'],
	ruchamp: ['european rugby champions cup', 'champions cup rugby', 'heineken cup'],
	rueuchamp: ['european challenge cup', 'rugby challenge cup'],
	ruwc: ['rugby world cup', 'rwc'],
	// Lacrosse
	pll: ['lacrosse', 'pll', 'premier lacrosse'],
	wll: ['womens lacrosse', 'wll'],
	// Table Tennis
	wttmen: ['table tennis', 'ping pong', 'wtt', 'world table tennis'],
	// Basketball — Euroleague
	euroleague: ['euroleague', 'euro league', 'basketball euroleague', 'eurobasket'],
	// Winter / Summer Olympics
	mwoh: ['winter olympics', 'winter olympic', 'olympics 2026'],
	wwoh: ['summer olympics', 'olympics 2028'],
	// World Baseball Classic
	wbc: ['world baseball classic', 'wbc baseball'],
	// Additional soccer leagues
	bra: ['brasileirao', 'brazilian football', 'brazil football', 'série a brazil', 'serie a brasil'],
	bra2: ['brasileirao serie b', 'brazil serie b'],
	arg: ['argentine football', 'argentina football', 'superliga argentina', 'primera division'],
	por: ['primeira liga', 'liga portugal', 'portuguese football'],
	chi: ['chilean football', 'primera division chile'],
	chi1: ['chilean primera division'],
	col: ['colombian football', 'liga colombiana'],
	col1: ['liga betplay', 'colombia betplay'],
	nor: ['norwegian eliteserien', 'eliteserien', 'norway football'],
	den: ['danish superliga', 'superliga denmark', 'denmark football'],
	jap: ['j-league', 'j league', 'japan football', 'j1 league'],
	ja2: ['j2 league', 'japan second division'],
	kor: ['k-league', 'k league', 'korea football'],
	spl: ['saudi pro league', 'saudi football', 'roshn league'],
	tur: ['super lig', 'süper lig', 'turkish super lig', 'turkey football'],
	rus: ['russian premier league', 'russia football', 'rpl'],
	ssc: ['scottish premiership', 'scottish football', 'spfl',
		// Scottish teams — both full names and common shortforms
		'celtic', 'celtic fc', 'hoops',
		'rangers fc', 'glasgow rangers', 'gers', 'ibrox',
		'hearts', 'heart of midlothian', 'jambos',
		'hibernian', 'hibs', 'hibees',
		'aberdeen', 'aberdeen fc', 'dons',
		'kilmarnock', 'killie',
		'motherwell', 'well',
		'st mirren', 'saints',
		'dundee', 'dundee fc', 'dee',
		'dundee united', 'united',
		'st johnstone', 'saints perth',
		'ross county', 'county',
		'livingston', 'livi',
		'inverness', 'ict',
		'partick thistle', 'partick', 'jags'],
	efl: ['efl championship', 'championship england', 'english championship', 'efl',
		// EFL Championship team names + 3-letter slug abbreviations used by Polymarket/Gamma
		'leeds united', 'leeds', 'lee', 'lufc',
		'sunderland', 'sunderland afc', 'safc', 'black cats',
		'sheffield united', 'sheffield utd', 'shu', 'blades',
		'burnley', 'bur', 'clarets',
		'west brom', 'west bromwich', 'west bromwich albion', 'wba', 'baggies',
		'middlesbrough', 'boro', 'mid',
		'millwall', 'the lions', 'mil',
		'coventry', 'coventry city', 'sky blues', 'cov',
		'norwich', 'norwich city', 'canaries', 'nor', 'ncfc',
		'bristol city', 'bcfc', 'robins', 'bri',
		'preston', 'preston north end', 'pne',
		'stoke', 'stoke city', 'potters', 'sto',
		'watford', 'hornets', 'wat',
		'qpr', 'queens park rangers', 'hoops qpr',
		'cardiff', 'cardiff city', 'bluebirds', 'car',
		'plymouth', 'plymouth argyle', 'ply', 'pilgrims',
		'swansea', 'swansea city', 'swans', 'swa',
		'luton', 'luton town', 'hatters', 'lut',
		'derby', 'derby county', 'rams', 'der',
		'hull', 'hull city', 'tigers', 'hul',
		'blackburn', 'blackburn rovers', 'rovers', 'bla',
		'oxford', 'oxford united', 'oxf', 'us',
		'portsmouth', 'pompey', 'por pom',
		'sheffield wednesday', 'shef wed', 'owls', 'shw',
		'bristol rovers', 'gas',
		'reading', 'royals', 'rea',
		'birmingham', 'birmingham city', 'brum', 'bcfc bham'],
	ere: ['eredivisie', 'dutch football', 'netherlands football', 'dutch league',
		'ajax', 'ajax amsterdam', 'godenzonen',
		'psv', 'psv eindhoven',
		'feyenoord', 'feyenoord rotterdam',
		'az alkmaar', 'az', 'kaasboeren',
		'twente', 'fc twente',
		'utrecht', 'fc utrecht',
		'groningen', 'fc groningen', 'trots van het noorden',
		'heerenveen', 'sc heerenveen',
		'sparta rotterdam', 'sparta',
		'nec nijmegen', 'nec',
		'go ahead eagles', 'go ahead',
		'fortuna sittard', 'fortuna',
		'pec zwolle', 'pec', 'zwolle',
		'heracles almelo', 'heracles',
		'almere city', 'almere',
		'rkc waalwijk', 'rkc',
		'excelsior', 'sbv excelsior'],
	fl1: ['ligue 1', 'french football', 'french league', 'ligue 1 uber eats',
		'paris saint-germain', 'psg', 'paris sg',
		'monaco', 'as monaco', 'asm',
		'lyon', 'olympique lyonnais', 'ol', 'les gones',
		'marseille', 'olympique de marseille', 'om', 'les phocéens',
		'lille', 'losc', 'losc lille',
		'nice', 'ogc nice', 'les aiglons',
		'lens', 'rc lens', 'les sang et or',
		'rennes', 'stade rennais', 'srfc',
		'toulouse', 'toulouse fc', 'tfc',
		'brest', 'stade brestois', 'brest fc',
		'nantes', 'fc nantes',
		'montpellier', 'mhsc',
		'reims', 'stade de reims',
		'strasbourg', 'rc strasbourg',
		'lorient', 'fc lorient',
		'metz', 'fc metz',
		'le havre', 'le havre ac', 'hac',
		'auxerre', 'aej auxerre',
		'angers', 'sco angers',
		'saint-etienne', 'as saint-etienne', 'asse'],
	itc: ['coppa italia', 'italy cup'],
	cde: ['copa del rey', 'spanish cup'],
	dfb: ['dfb pokal', 'german cup', 'dfb cup'],
	lib: ['copa libertadores', 'libertadores'],
	sud: ['copa sudamericana', 'sudamericana'],
	con: ['concacaf champions', 'champions cup concacaf'],
	cof: ['conmebol', 'south america confederation'],
	afc: ['afc asian cup', 'asian cup football'],
	ofc: ['ofc nations cup', 'oceania football'],
	uef: ['uefa nations league', 'nations league'],
	caf: ['afcon', 'africa cup of nations', 'caf championship'],
	acn: ['africa cup of nations', 'afcon 2025', 'acn'],
	efa: ['egyptian premier league', 'egypt football'],
	csa: ['south american u20', 'conmebol u20'],
	cdr: ['copa del rey round'],
	abb: ['afc champions league', 'asian champions league'],
	uwcl: ['womens champions league', "women's champions league", 'uwcl'],
	fif: ['fifa tournament', 'fifa championship', 'cup of nations'],
	mar1: ['botola pro', 'moroccan football', 'morocco league'],
	egy1: ['egyptian premier league 2'],
	cze1: ['czech first league', 'fortuna liga', 'czech football'],
	bol1: ['bolivian football', 'liga boliviana'],
	rou1: ['romanian liga 1', 'superliga romania'],
	per1: ['peruvian football', 'liga 1 peru'],
	ukr1: ['ukrainian premier league', 'ukraine football', 'upl'],
	// Formula 1
	f1: ['formula 1', 'formula one', 'f1', 'grand prix', 'ferrari', 'red bull racing', 'mercedes f1', 'verstappen', 'hamilton'],
	// Golf
	golf: ['pga tour', 'golf', 'masters', 'british open', 'us open golf', 'ryder cup'],
	// Boxing
	boxing: ['boxing', 'heavyweight', 'knockout', 'wbc boxing', 'wba', 'ibf'],
};

/**
 * Extra tag labels to search as fallbacks (lowercase).
 * These are used to search events by tag name when sport detection matches.
 */
const ESPORTS_TAG_LABELS = ['esports', 'lol', 'league of legends', 'cs2', 'dota2', 'valorant'];

/**
 * Maps full esports/sports team names to their slug abbreviations.
 * Applied during keyword extraction so "JD Gaming" → "jdg" matches
 * event slugs like `lol-jdg-blg-2026-03-04`.
 */
const TEAM_ABBREVIATIONS: Record<string, string> = {
	// LPL (LoL)
	'jd gaming': 'jdg',
	'bilibili gaming': 'blg',
	'top esports': 'tes',
	'weibo gaming': 'wbg',
	'invictus gaming': 'ig',
	'funplus phoenix': 'fpx',
	'ninjas in pyjamas': 'nip',
	"anyone's legend": 'al',
	'anyones legend': 'al',
	'royal never give up': 'rng',
	'edward gaming': 'edg',
	'lng esports': 'lng',
	'oh my god': 'omg',
	'rare atom': 'ra',
	// LCK (LoL)
	'kt rolster': 'ktc',
	'dplus kia': 'dk',
	'hanwha life esports': 'hle',
	'hanwha life': 'hle',
	'nongshim redforce': 'ns',
	'bnk fearx': 'bnk',
	'kwangdong freecs': 'dnf',
	// LCS / LEC (LoL)
	'team liquid': 'tl',
	'cloud9': 'c9',
	'evil geniuses': 'eg',
	'counter logic gaming': 'clg',
	'golden guardians': 'gg',
	'flyquest': 'fly',
	'100 thieves': '100t',
	'shopify rebellion': 'shopify',
	'g2 esports': 'g2',
	'team vitality': 'vit',
	'mad lions': 'mad',
	'karmine corp': 'kc',
	'team bds': 'bds',
	// CS2
	'natus vincere': 'navi',
	'g2 ares': 'g2a',
	'team spirit': 'spirit',
	'virtus pro': 'vp',
	'team heretics': 'heretics',
	// Valorant
	'sentinels': 'sen',
	'paper rex': 'prx',
	'loud esports': 'loud',
	// General
	'colossal gaming': 'cg',
};

/**
 * Country names → ISO slug codes used in Polymarket sports event slugs.
 * Applied during keyword extraction so "Malaysia vs Bahrain" → keywords
 * include "mys" and "bhr", matching slugs like `crint-mys-bhr-2026-03-10`.
 */
const COUNTRY_TO_SLUG_CODE: Record<string, string> = {
	// Cricket-playing nations (primary use case — international cricket slugs)
	malaysia: 'mys', bahrain: 'bhr', india: 'ind', australia: 'aus',
	england: 'eng', pakistan: 'pak', bangladesh: 'bgd', nepal: 'npl',
	oman: 'omn', namibia: 'nam', ireland: 'ire', scotland: 'sco',
	zimbabwe: 'zim', afghanistan: 'afg', kenya: 'ken', uganda: 'uga',
	singapore: 'sgp', hongkong: 'hkg', qatar: 'qat', kuwait: 'kwt',
	bermuda: 'bmu', botswana: 'bwa', cameroon: 'cmr', ghana: 'gha',
	guernsey: 'ggy', jersey: 'jey', nigeria: 'nga', rwanda: 'rwa',
	tanzania: 'tza', thailand: 'tha', vanuatu: 'vut', samoa: 'wsm',
	fiji: 'fji', png: 'png', suriname: 'sur', argentina: 'arg',
	// Multi-word country names
	'new zealand': 'nzl', 'south africa': 'rsa', 'sri lanka': 'slk',
	'west indies': 'win', 'united arab emirates': 'uae', 'saudi arabia': 'ksa',
	'papua new guinea': 'png',
	// Soccer/football nations used in Polymarket slugs
	brazil: 'bra', mexico: 'mex', japan: 'jpn', korea: 'kor',
	china: 'chn', turkey: 'tur', russia: 'rus', portugal: 'por',
	denmark: 'den', norway: 'nor', sweden: 'swe', finland: 'fin',
	croatia: 'cro', serbia: 'srb', ukraine: 'ukr',
};

/**
 * Category keywords → Gamma API tag slugs.
 * "show me politics" → fetch events tagged "politics".
 */
const CATEGORY_TAG_MAP: Record<string, string> = {
	politics: 'politics', political: 'politics', election: 'politics', elections: 'politics',
	crypto: 'crypto', cryptocurrency: 'crypto', bitcoin: 'crypto', btc: 'crypto', ethereum: 'crypto', eth: 'crypto',
	sports: 'sports', sport: 'sports',
	finance: 'finance', financial: 'finance', stocks: 'finance', stock: 'finance', market: 'finance',
	geopolitics: 'geopolitics', geopolitical: 'geopolitics', war: 'geopolitics', conflict: 'geopolitics',
	tech: 'tech', technology: 'tech', ai: 'tech', artificial: 'tech',
	culture: 'culture', entertainment: 'culture', movies: 'culture', oscars: 'culture', music: 'culture',
	world: 'world', global: 'world', international: 'world',
	economy: 'economy', economic: 'economy', gdp: 'economy', inflation: 'economy', recession: 'economy',
};

/** Words that indicate the user wants trending / most popular markets. */
const TRENDING_KEYWORDS = new Set([
	'trending', 'trend', 'trends', 'hot', 'popular', 'biggest', 'top',
	'breaking', 'viral', 'movers', 'active', 'busiest',
]);

/**
 * For well-known player markets whose slugs can't be derived from the player's
 * name alone (e.g. "messi" → slug has "lionel", "fifa", "in-the"), we keep a
 * direct keyword → event-slug mapping. Keys are lowercase player names / phrases.
 * The search code checks these BEFORE the general slug-generation step.
 */
const PLAYER_SLUG_OVERRIDES: Record<string, string> = {
	// Soccer — keyed by space-separated words that must ALL appear in query
	'messi world cup': 'will-lionel-messi-play-in-the-2026-fifa-world-cup',
	'messi fifa world cup': 'will-lionel-messi-play-in-the-2026-fifa-world-cup',
	'messi retire': 'will-lionel-messi-retire-from-professional-soccer',
	// NBA — player props only needed when query is ambiguous w/ general overrides
	'wembanyama quadruple': 'will-victor-wembanyama-record-a-quadruple-double-this-season',
	'tatum play season': 'will-jayson-tatum-play-a-game-this-season',
	'tatum play this season': 'will-jayson-tatum-play-a-game-this-season',
	'jayson tatum play': 'will-jayson-tatum-play-a-game-this-season',
	'lebron retire': 'will-lebron-james-retire-before-next-nba-season',
};

/** Words that indicate the user wants recently created markets. */
const RECENCY_KEYWORDS = new Set([
	'new', 'newest', 'latest', 'recent', 'fresh', 'just', 'launched', 'today',
]);

/**
 * Common abbreviations / nicknames → expanded forms.
 * Applied as whole-word replacements before AI extraction and slug generation
 * so that e.g. "BTC" produces "bitcoin" slugs, "DJT" produces "trump" slugs.
 */
const QUERY_SYNONYMS: Record<string, string> = {
	btc: 'bitcoin',
	eth: 'ethereum',
	bnb: 'binance',
	sol: 'solana',
	xrp: 'ripple',
	doge: 'dogecoin',
	djt: 'trump',
	potus: 'president',
	gop: 'republican',
	dem: 'democrat',
	sb: 'super bowl',
	mlk: 'martin luther king',
};

/**
 * Shared stopwords used across the entire search pipeline.
 * Conservative: only truly universal conversational/structural noise.
 * Domain-specific terms like 'game', 'match', 'win', 'score' are NOT here
 * because they're meaningful in sports/esports queries.
 */
const COMMON_STOPWORDS = new Set([
	// Articles / prepositions / conjunctions
	'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'is', 'are', 'be',
	'and', 'or', 'vs', 'versus',
	// Conversational filler
	'hi', 'hey', 'hello', 'can', 'you', 'me', 'please', 'show', 'tell',
	'about', 'check', 'find', 'get', 'give', 'see', 'looking',
	// Question words
	'who', 'what', 'whats', 'how', 'which', 'will', 'do', 'does', 'did',
	'has', 'have', 'been', 'would', 'should', 'could',
	// Generic request words
	'market', 'markets', 'odds', 'status', 'update', 'updates',
	'current', 'live', 'going', 'this', 'that', 'it', 'its', 'any',
	'right', 'now',
]);

/** Expand known abbreviations/nicknames in a query string (whole-word, case-insensitive). */
function expandSynonyms(query: string): string {
	let result = query;
	for (const [abbr, full] of Object.entries(QUERY_SYNONYMS)) {
		result = result.replace(new RegExp(`\\b${abbr}\\b`, 'gi'), full);
	}
	return result;
}

/** Cache for Polymarket tags (from /tags endpoint). */
interface TagEntry {
	readonly id: string;
	readonly label: string;
	readonly slug: string;
}
let tagsCache: TagEntry[] | null = null;
let tagsCacheExpiresAt = 0;
const TAGS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Raw market shape returned by the Gamma API.
 * Only the fields we actually use are typed here; the real payload has many more.
 */

interface GammaMarketResponse {
	readonly id?: string;
	readonly condition_id?: string;
	readonly conditionId?: string; // Gamma API returns camelCase
	readonly question?: string;
	readonly title?: string; // events payload may use title
	readonly slug?: string; // URL-friendly slug for constructing Polymarket/Olympus links
	readonly active?: boolean;
	readonly closed?: boolean;
	readonly outcomes?: string | string[]; // Gamma markets use JSON string; events may send string[]
	readonly outcomePrices?: string | string[]; // JSON string or array of price strings
	readonly volume?: string | number;
	readonly volume24hr?: number;       // 24-hour trading volume (used for trending/ranking)
	readonly competitive?: number;       // competitiveness score 0–1 (closer to 0.5 = more interesting)
	readonly featured?: boolean;         // Polymarket staff-featured market
	readonly accepting_orders?: boolean;
	readonly events?: ReadonlyArray<{ readonly slug?: string }>; // parent event(s) — slug used for Polymarket event URLs
}

/**
 * PolymarketReadProvider backed by the public Polymarket Gamma API.
 *
 * This provider is read-only and requires NO authentication.
 * It can power the full READ pipeline (AI assistant mode) without any backend.
 */
export class PolymarketApiReadProvider implements PolymarketReadProvider {
	/**
	 * Fetches ALL active markets from the Gamma API via pagination.
	 * Results are cached in Redis for 5 minutes to avoid hammering the API.
	 */
	public async listMarkets(): Promise<readonly Market[]> {
		return getOrFetch(
			'polybot:markets:active',
			async () => {
				const baseUrl = `${GAMMA_API_BASE}/markets?closed=false`;
				const all = await this.fetchAllMarkets(baseUrl);
				console.log(`[listMarkets] Fetched ${all.length} active markets from API`);
				return all;
			},
			60, // 1 minute TTL — fresher prices, especially for live sports
		);
	}

	/**
	 * Fetches live prices for a single market directly from the Gamma API (uncached).
	 * Used to refresh stale cached prices before showing them to the user.
	 * Returns updated outcomePrices or null if the fetch fails.
	 */
	public async refreshMarketPrices(market: Market): Promise<Market> {
		try {
			// Use slug-based single-market endpoint — the /markets?condition_id= query
			// param is non-functional (Gamma API ignores it and returns all markets from
			// page 1, causing stale [0,0] prices from old markets to overwrite valid data).
			if (!market.slug) return market; // slug required for lookup
			const url = `${GAMMA_API_BASE}/markets/${encodeURIComponent(market.slug)}`;
			const response = await fetch(url);
			if (!response.ok) return market;

			const raw = (await response.json()) as GammaMarketResponse;
			// Sanity check: make sure the returned market matches what we asked for
			const returnedId = raw.conditionId ?? raw.condition_id;
			if (returnedId && returnedId !== market.id) {
				console.warn(`[refresh] conditionId mismatch for slug "${market.slug}": expected ${market.id}, got ${returnedId}`);
				return market;
			}

			const freshPrices = parseOutcomePrices(raw.outcomePrices, market.outcomes.length);
			if (freshPrices.length > 0) {
				console.log(`[refresh] Prices updated for "${market.question}": ${market.outcomePrices} → ${freshPrices}`);
				return { ...market, outcomePrices: freshPrices };
			}
		} catch (err) {
			console.warn('[refresh] Failed to fetch live prices:', err);
		}
		return market;
	}

	/**
	 * Fetches a single market by its condition ID / slug.
	 */
	public async getMarket(marketId: MarketId): Promise<Market | null> {
		try {
			const url = `${GAMMA_API_BASE}/markets/${encodeURIComponent(marketId)}`;
			const response = await fetch(url);

			if (!response.ok) {
				return null;
			}

			const raw = (await response.json()) as GammaMarketResponse;
			return mapGammaMarketToMarket(raw);
		} catch {
			return null;
		}
	}

	/**
	 * Searches markets by text using the Gamma API's slug/text filtering.
	 */
	public async searchMarkets(query: string): Promise<readonly Market[]> {
		const normalized = query.trim();
		if (normalized.length === 0) {
			return this.listMarkets();
		}

		console.log(`[search] Raw query: "${normalized}"`);

		// ──────────────────────────────────────────────────────────────────────
		// 0. DIRECT LOOKUP — Polymarket URL or condition ID in the query
		// ──────────────────────────────────────────────────────────────────────
		// Match polymarket.com/event/<event-slug> or polymarket.com/event/<event-slug>/<market-slug>
		const urlMatch = normalized.match(/polymarket\.com\/event\/([a-z0-9-]+)/i);
		if (urlMatch) {
			const eventSlug = urlMatch[1];
			console.log(`[search] Polymarket URL detected, event slug: "${eventSlug}"`);
			try {
				const eventUrl = `${GAMMA_API_BASE}/events?closed=false&limit=1&slug=${encodeURIComponent(eventSlug)}`;
				const resp = await fetch(eventUrl);
				if (resp.ok) {
					const events = await resp.json();
					if (Array.isArray(events) && events.length > 0 && Array.isArray(events[0].markets)) {
						const markets = events[0].markets
							.map(mapGammaMarketToMarket)
							.filter((m: Market | null): m is Market => m !== null);
						if (markets.length > 0) {
							console.log(`[search] Direct URL hit: ${markets.length} markets`);
							return markets;
						}
					}
				}
				// Also try closed events
				const closedUrl = `${GAMMA_API_BASE}/events?closed=true&limit=1&slug=${encodeURIComponent(eventSlug)}`;
				const closedResp = await fetch(closedUrl);
				if (closedResp.ok) {
					const closedEvents = await closedResp.json();
					if (Array.isArray(closedEvents) && closedEvents.length > 0 && Array.isArray(closedEvents[0].markets)) {
						const markets = closedEvents[0].markets
							.map(mapGammaMarketToMarket)
							.filter((m: Market | null): m is Market => m !== null);
						if (markets.length > 0) return markets;
					}
				}
			} catch {
				// best-effort; fall through to normal search
			}
		}
		// Match condition IDs (0x-prefixed hex, 66 chars)
		const conditionIdMatch = normalized.match(/\b(0x[a-fA-F0-9]{64})\b/);
		if (conditionIdMatch) {
			const conditionId = conditionIdMatch[1];
			console.log(`[search] Condition ID detected: "${conditionId}"`);
			const direct = await this.getMarket(conditionId as MarketId);
			if (direct) {
				console.log(`[search] Direct condition ID hit: "${direct.question}"`);
				return [direct];
			}
		}
		// Normalize accented chars to ASCII (e.g. "Rodríguez" → "Rodriguez") so they
		// don't get split into fragments like "rodr" + "guez" by the ASCII-only regex.
		const asciiQuery = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
		const lower = asciiQuery.toLowerCase();
		const queryWords = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);

		// ──────────────────────────────────────────────────────────────────────
		// 1. TRENDING / HOT — "what's trending?", "top markets", "most popular"
		// ──────────────────────────────────────────────────────────────────────
		if (queryWords.some(w => TRENDING_KEYWORDS.has(w))) {
			console.log(`[search] Trending query detected`);
			const trending = await this.fetchTrendingEvents(15);
			if (trending.length > 0) {
				console.log(`[search] Returning ${trending.length} trending markets`);
				return trending;
			}
		}

		// ──────────────────────────────────────────────────────────────────────
		// 2. RECENCY — "what's new?", "latest markets", "anything fresh?"
		//    Skip for matchup queries ("X vs Y today") — those need sports search
		// ──────────────────────────────────────────────────────────────────────
		if (queryWords.some(w => RECENCY_KEYWORDS.has(w)) && !queryWords.some(w => TRENDING_KEYWORDS.has(w)) && !lower.includes(' vs ')) {
			console.log(`[search] Recency query detected`);
			const recent = await this.fetchNewEvents(15);
			if (recent.length > 0) {
				console.log(`[search] Returning ${recent.length} new markets`);
				return recent;
			}
		}

		// ──────────────────────────────────────────────────────────────────────
		// 3. CATEGORY — "show me politics", "crypto markets", "sports"
		//    Only fire for single-topic generic queries (≤1 content word).
		//    Multi-word queries like "bitcoin ETF approval" must NOT trigger
		//    the crypto category — they need specific slug/event search.
		// ──────────────────────────────────────────────────────────────────────
		const CATEGORY_NOISE = new Set(['show', 'me', 'markets', 'market', 'latest', 'top', 'list', 'get', 'find', 'whats', 'happening', 'in', 'any']);
		const meaningfulQueryWords = queryWords.filter(w => !CATEGORY_NOISE.has(w));
		if (meaningfulQueryWords.length <= 1) {
			for (const w of queryWords) {
				const tagSlug = CATEGORY_TAG_MAP[w];
				if (tagSlug) {
					console.log(`[search] Category detected: "${w}" → tag "${tagSlug}"`);
					const catResults = await this.fetchEventsByTag(tagSlug, 20);
					if (catResults.length > 0) {
						console.log(`[search] Returning ${catResults.length} category markets for "${tagSlug}"`);
						return catResults;
					}
				}
			}
		}

		// Expand common abbreviations/nicknames before any AI or slug work
		const synonymExpanded = expandSynonyms(normalized);

		// Combined AI call: extract keywords AND predict likely slug fragments in one round-trip.
		// Falls back gracefully if AI is unavailable.
		const { keywords: rawSearchTerms, slugPredictions: aiSlugPredictions } =
			await extractKeywordsAndSlugs(synonymExpanded);
		// Normalize accented chars to ASCII so downstream slug/keyword logic works
		// correctly for names like "Rodríguez" → "Rodriguez".
		const searchTerms = rawSearchTerms.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
		console.log(`[search] AI-extracted keywords: "${searchTerms}"${aiSlugPredictions.length ? ` | slug hints: ${aiSlugPredictions.slice(0, 3).join(', ')}` : ''}`);

		// If AI returned empty (vague query like "anything interesting?"), show trending
		if (searchTerms.trim().length === 0) {
			console.log(`[search] Empty keywords from AI, falling back to trending`);
			const trending = await this.fetchTrendingEvents(15);
			if (trending.length > 0) return trending;
		}

		// Try events endpoint with multiple slug candidates
		let eventMarkets: Market[] = [];

		// Check player slug overrides first — for well-known markets whose slugs
		// can't be derived from the query alone (e.g. "messi" → needs "lionel", "fifa")
		const searchTermsLower = searchTerms.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
		const searchTermsWords = new Set(searchTermsLower.split(/\s+/));
		for (const [phrase, overrideSlug] of Object.entries(PLAYER_SLUG_OVERRIDES)) {
			// Match if ALL words in the phrase appear in the query (order-independent)
			const phraseWords = phrase.split(/\s+/);
			const allMatch = phraseWords.every(pw => searchTermsWords.has(pw) || searchTermsLower.includes(pw));
			if (allMatch) {
				console.log(`[search] Player override match: "${phrase}" → "${overrideSlug}"`);
				try {
					const overrideUrl = `${GAMMA_API_BASE}/events?closed=false&limit=1&slug=${encodeURIComponent(overrideSlug)}`;
					const overrideResp = await fetch(overrideUrl);
					if (overrideResp.ok) {
						const overrideEvents = await overrideResp.json();
						if (Array.isArray(overrideEvents) && overrideEvents.length > 0 && Array.isArray(overrideEvents[0].markets)) {
							console.log(`[search] Player override hit! slug="${overrideSlug}" title="${overrideEvents[0].title}"`);
							eventMarkets = overrideEvents[0].markets
								.map(mapGammaMarketToMarket)
								.filter((m: Market | null): m is Market => m !== null);
						}
					}
				} catch {
					// best-effort; continue to normal slug search
				}
				break;
			}
		}

		// If player override found results, score and return them
		if (eventMarkets.length > 0) {
			return this.scoreAndSortEventMarkets(eventMarkets, searchTerms);
		}

		// ──────────────────────────────────────────────────────────────────────
		// SPORTS-FIRST — for vs-queries, run sports search BEFORE slug/text
		// search. This prevents irrelevant slug results from short-circuiting
		// the precise series-based sports search.
		// Only triggered for queries containing "vs"/"versus" — category
		// queries like "show me sports" skip this and go to slug/text.
		// ──────────────────────────────────────────────────────────────────────
		const lowerSearchTerms = searchTerms.toLowerCase();
		const isSportsFirstCandidate = lowerSearchTerms.includes(' vs ') || lowerSearchTerms.includes(' versus ');
		if (isSportsFirstCandidate) {
			console.log(`[search] Attempting sports-first search for vs-query: "${searchTerms}"`);
			const sportsFirstResults = await this.searchSportsMarkets(searchTerms);
			if (sportsFirstResults.length > 0) {
				console.log(`[search] Sports-first found ${sportsFirstResults.length} markets, returning`);
				return sportsFirstResults;
			}
		}

		// ──────────────────────────────────────────────────────────────────────
		// PARALLEL SEARCH: Run slug candidates + events text_query concurrently
		// then merge results for best coverage.
		// ──────────────────────────────────────────────────────────────────────
		const cleanedKeywords = cleanSearchKeywords(searchTerms);

		// Build slug candidate list: AI predictions first (more likely correct),
		// then mechanical permutations as fallback.
		const mechanicalCandidates = buildEventSlugCandidates(searchTerms);
		const aiNormalized = aiSlugPredictions.map(s =>
			s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''),
		).filter(s => s.length >= 5);
		const seenSlugs = new Set<string>();
		const eventSlugCandidates: string[] = [];
		for (const s of [...aiNormalized, ...mechanicalCandidates]) {
			if (!seenSlugs.has(s)) { seenSlugs.add(s); eventSlugCandidates.push(s); }
		}
		console.log(`[search] Event slug candidates (${eventSlugCandidates.length}):`, eventSlugCandidates.slice(0, 6));

		// Strategy A: Slug-based event search (parallel batches)
		const slugSearchPromise = (async (): Promise<Market[]> => {
			const SLUG_BATCH = 6;
			for (const scope of ['closed=false', 'closed=true']) {
				for (let i = 0; i < eventSlugCandidates.length; i += SLUG_BATCH) {
					const batch = eventSlugCandidates.slice(i, i + SLUG_BATCH);
					const batchResults = await Promise.all(batch.map(async slug => {
						try {
							const eventUrl = `${GAMMA_API_BASE}/events?${scope}&limit=1&slug=${encodeURIComponent(slug)}`;
							const eventResp = await fetch(eventUrl);
							if (!eventResp.ok) return null;
							const events = await eventResp.json();
							if (Array.isArray(events) && events.length > 0 && Array.isArray(events[0].markets) && events[0].markets.length > 0) {
								return { slug, event: events[0] };
							}
						} catch { /* best-effort */ }
						return null;
					}));
					for (const result of batchResults) {
						if (result) {
							console.log(`[search] Slug hit! slug="${result.slug}" title="${result.event.title}" markets=${result.event.markets.length}`);
							return result.event.markets
								.map(mapGammaMarketToMarket)
								.filter((m: Market | null): m is Market => m !== null);
						}
					}
				}
			}
			return [];
		})();

		// Strategy B: Events text_query search (Gamma's full-text search — primary strategy)
		const textQueryPromise = this.searchEventsByText(cleanedKeywords);

		// Run both strategies in parallel
		const [slugMarkets, textQueryMarkets] = await Promise.all([slugSearchPromise, textQueryPromise]);
		console.log(`[search] Parallel results: slug=${slugMarkets.length}, text_query=${textQueryMarkets.length}`);

		// Merge and deduplicate — slug results first (higher precision), then text_query
		const mergedDeduped = new Map<string, Market>();
		for (const m of [...slugMarkets, ...textQueryMarkets]) {
			if (!mergedDeduped.has(m.id)) {
				mergedDeduped.set(m.id, m);
			}
		}

		if (mergedDeduped.size > 0) {
			const mergedMarkets = [...mergedDeduped.values()];
			return this.scoreAndSortEventMarkets(mergedMarkets, searchTerms);
		}

		// Sports search fallback — for non-vs queries that weren't handled by
		// sports-first above (e.g. "NBA championship", "cricket world cup").
		// Vs-queries already attempted sports search above, so skip for them.
		if (!isSportsFirstCandidate) {
			console.log(`[search] Attempting sports fallback for: "${searchTerms}"`);
			const sportsResults = await this.searchSportsMarkets(searchTerms);
			if (sportsResults.length > 0) {
				console.log(`[search] Sports fallback found ${sportsResults.length} markets`);
				return sportsResults;
			}
		}

		// ──────────────────────────────────────────────────────────────────────
		// 5. SUB-TAG MATCHING — fuzzy-match query against Polymarket's /tags
		// ──────────────────────────────────────────────────────────────────────
		const tagMatch = await this.matchQueryToTag(searchTerms);
		if (tagMatch) {
			console.log(`[search] Tag match: "${searchTerms}" → tag "${tagMatch}"`);
			const tagResults = await this.fetchEventsByTag(tagMatch, 15);
			if (tagResults.length > 0) {
				console.log(`[search] Returning ${tagResults.length} markets for tag "${tagMatch}"`);
				return tagResults;
			}
		}

		// --- Last-resort fallback: Markets slug, tag, and text_query searches ---
		const searchSlug = cleanedKeywords.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		let mSlugResults: Market[] = [];
		let mTagResults: Market[] = [];
		let mTextResults: Market[] = [];
		for (const scope of ['closed=false', 'closed=true']) {
			const slugUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&slug=${encodeURIComponent(searchSlug)}`;
			mSlugResults = mSlugResults.concat(await this.fetchAndMapMarkets(slugUrl));

			const tagUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&tag=${encodeURIComponent(cleanedKeywords)}`;
			mTagResults = mTagResults.concat(await this.fetchAndMapMarkets(tagUrl));

			const textUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&text_query=${encodeURIComponent(cleanedKeywords)}`;
			mTextResults = mTextResults.concat(await this.fetchAndMapMarkets(textUrl));
		}

		// Merge and deduplicate by market id
		const deduped = new Map<string, Market>();
		for (const m of [...mSlugResults, ...mTagResults, ...mTextResults]) {
			if (!deduped.has(m.id)) {
				deduped.set(m.id, m);
			}
		}

		// Relevance filter: only keep markets whose question contains at least one
		// query keyword. Without this, the Gamma API returns hundreds of irrelevant markets.
		const filterKeywords = cleanedKeywords
			.toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').split(/\s+/)
			.filter(w => w.length >= 2);
		// Extended stopwords for the final fallback (includes domain-specific terms
		// that are too generic to be useful as relevance signals in the market-level search)
		const FALLBACK_EXTRA_STOPWORDS = new Set([
			'today', 'tonight', 'latest', 'bring', 'up', 'chance', 'chances', 'probability',
			'game', 'match', 'play', 'score', 'result', 'series', 'season',
			'playoffs', 'league', 'tournament', 'cup', 'championship',
			'sports', 'esports', 'regular', 'kickoff',
		]);
		const relevantKeywords = filterKeywords.filter(w => !COMMON_STOPWORDS.has(w) && !FALLBACK_EXTRA_STOPWORDS.has(w));
		// Separate word-keywords from numeric-only tokens (years like "2026" appear in
		// almost every market and must not be the SOLE relevance signal).
		const wordKeywords = relevantKeywords.filter(w => /[a-z]/.test(w));
		const numericKeywords = relevantKeywords.filter(w => !/[a-z]/.test(w));
		const mustMatchKeywords = wordKeywords.length > 0 ? wordKeywords : numericKeywords;

		let filtered: Market[];
		if (mustMatchKeywords.length > 0) {
			filtered = [...deduped.values()].filter(m => {
				const q = m.question.toLowerCase();
				return mustMatchKeywords.some(kw => q.includes(kw));
			});
			console.log(`[search] Relevance filter: ${deduped.size} → ${filtered.length} (keywords: ${relevantKeywords.join(', ')})`);
		} else {
			filtered = [...deduped.values()];
		}

		// TF-IDF scoring: weight rare keywords higher than common ones
		filtered.sort((a, b) => {
			const rankStatus = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
			const statusDiff = rankStatus(a.status) - rankStatus(b.status);
			if (statusDiff !== 0) return statusDiff;
			const scoreDiff = tfidfScore(b, relevantKeywords, filtered) - tfidfScore(a, relevantKeywords, filtered);
			if (scoreDiff !== 0) return scoreDiff;
			return Math.log10(Math.max(b.volume || 1, 1)) - Math.log10(Math.max(a.volume || 1, 1));
		});
		const results = filtered;
		console.log(`[search] Results: slug=${mSlugResults.length} tag=${mTagResults.length} text=${mTextResults.length} relevant=${results.length}`);
		return results;
	}

	/**
	 * Shared fetch + parse logic for list/search endpoints.
	 */
	private async fetchAndMapMarkets(url: string): Promise<readonly Market[]> {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				return [];
			}

			const raw = (await response.json()) as GammaMarketResponse[] | GammaMarketResponse;

			// API may return a single object or an array
			const items = Array.isArray(raw) ? raw : [raw];
			const mapped = items.map(mapGammaMarketToMarket).filter((m): m is Market => m !== null);
			return mapped;
		} catch {
			return [];
		}
	}

	// ══════════════════════════════════════════════════════════════════════
	// NEW: Trending, category, recency, and tag-based fetchers
	// ══════════════════════════════════════════════════════════════════════

	/**
	 * Fetches top events sorted by 24-hour volume (trending/hot markets).
	 */
	private async fetchTrendingEvents(limit: number): Promise<Market[]> {
		try {
			const url = `${GAMMA_API_BASE}/events?closed=false&order=volume24hr&ascending=false&limit=${limit}`;
			const resp = await fetch(url);
			if (!resp.ok) return [];
			const events = await resp.json();
			if (!Array.isArray(events)) return [];
			const markets: Market[] = [];
			for (const evt of events) {
				if (Array.isArray(evt.markets)) {
					// Take only the first market from each event for variety
					const mapped = mapGammaMarketToMarket(evt.markets[0]);
					if (mapped) markets.push(mapped);
				}
			}
			return markets;
		} catch {
			return [];
		}
	}

	/**
	 * Fetches newest events sorted by creation date.
	 */
	private async fetchNewEvents(limit: number): Promise<Market[]> {
		try {
			const url = `${GAMMA_API_BASE}/events?closed=false&order=createdAt&ascending=false&limit=${limit}`;
			const resp = await fetch(url);
			if (!resp.ok) return [];
			const events = await resp.json();
			if (!Array.isArray(events)) return [];
			const markets: Market[] = [];
			for (const evt of events) {
				if (Array.isArray(evt.markets)) {
					const mapped = mapGammaMarketToMarket(evt.markets[0]);
					if (mapped) markets.push(mapped);
				}
			}
			return markets;
		} catch {
			return [];
		}
	}

	/**
	 * Fetches events for a specific tag slug, sorted by volume.
	 */
	private async fetchEventsByTag(tagSlug: string, limit: number): Promise<Market[]> {
		try {
			const url = `${GAMMA_API_BASE}/events?closed=false&tag_slug=${encodeURIComponent(tagSlug)}&order=volume24hr&ascending=false&limit=${limit}`;
			const resp = await fetch(url);
			if (!resp.ok) return [];
			const events = await resp.json();
			if (!Array.isArray(events)) return [];
			const markets: Market[] = [];
			for (const evt of events) {
				if (Array.isArray(evt.markets)) {
					const mapped = mapGammaMarketToMarket(evt.markets[0]);
					if (mapped) markets.push(mapped);
				}
			}
			return markets;
		} catch {
			return [];
		}
	}

	/**
	 * Fuzzy-matches search query words against the full Polymarket /tags list.
	 * Returns the best matching tag slug, or null if no match.
	 */
	private async matchQueryToTag(query: string): Promise<string | null> {
		const tags = await this.fetchAllTags();
		if (tags.length === 0) return null;

		const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
		if (words.length === 0) return null;

		const lowerQuery = query.toLowerCase();

		// Pass 1: the full tag label appears verbatim in the query
		// e.g. query "UEFA Champions League winner" → label "champions league" → match
		for (const tag of tags) {
			const label = tag.label.toLowerCase();
			if (lowerQuery.includes(label)) {
				return tag.slug;
			}
		}

		// Pass 2: ALL words of the tag label appear (as words) in the query words
		// This prevents single-word false positives like "super" matching "Super Rugby Pacific"
		// because "rugby" and "pacific" do NOT appear in the query.
		for (const tag of tags) {
			const labelWords = tag.label.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
				.filter(w => w.length >= 3);
			if (labelWords.length === 0) continue;
			const allMatch = labelWords.every(lw => words.includes(lw));
			if (allMatch) {
				return tag.slug;
			}
		}

		return null;
	}

	/**
	 * Fetches and caches all Polymarket tags (1-hour TTL).
	 */
	private async fetchAllTags(): Promise<TagEntry[]> {
		if (tagsCache && Date.now() < tagsCacheExpiresAt) {
			return tagsCache;
		}
		try {
			const resp = await fetch(`${GAMMA_API_BASE}/tags`);
			if (!resp.ok) return tagsCache ?? [];
			const raw = await resp.json();
			if (!Array.isArray(raw)) return [];
			tagsCache = raw.map((t: Record<string, unknown>) => ({
				id: String(t.id ?? ''),
				label: String(t.label ?? ''),
				slug: String(t.slug ?? ''),
			}));
			tagsCacheExpiresAt = Date.now() + TAGS_CACHE_TTL_MS;
			console.log(`[tags] Cached ${tagsCache.length} tags`);
			return tagsCache;
		} catch {
			return tagsCache ?? [];
		}
	}

	/**
	 * Paginates through markets using limit/offset until exhausted or capped.
	 */
	private async fetchAllMarkets(urlBase: string): Promise<Market[]> {
		const results: Market[] = [];
		for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
			const offset = page * SEARCH_PAGE_LIMIT;
			const url = `${urlBase}&limit=${SEARCH_PAGE_LIMIT}&offset=${offset}`;
			const pageResults = await this.fetchAndMapMarkets(url);
			if (pageResults.length === 0) {
				break;
			}
			results.push(...pageResults);
			if (pageResults.length < SEARCH_PAGE_LIMIT) {
				break;
			}
		}
		return results;
	}

	/**
	 * Searches the Gamma events endpoint directly by text query.
	 * This catches specific matchup queries like "KTC vs DRXC" that have no
	 * matching slug but ARE findable via the events text search index.
	 */
	/**
	 * Sports-aware search: detects sport/esports categories from the query,
	 * then tries two strategies:
	 *
	 * 1. Series-specific search — paginates the sport's series_id events and
	 *    matches event slugs/titles against the query keywords. This catches
	 *    specific matchup queries like "KTC vs DRXC" that sit below the
	 *    top-volume events returned by tag-based searches.
	 *
	 * 2. Tag-based search — returns the top active events for that sport
	 *    (used when the user asks a general question like "show me lol markets").
	 */
	private async searchSportsMarkets(query: string): Promise<Market[]> {
		let detectedSports = detectSportsFromQuery(query);
		const lowerQuery = query.toLowerCase();
		const isVsQuery = lowerQuery.includes(' vs ') || lowerQuery.includes(' versus ');

		// Fetch sports metadata (cached) — needed for dynamic detection and series search.
		const sportsMeta = await fetchSportsMetadata();
		if (sportsMeta.length === 0) {
			console.log('[search] Failed to fetch sports metadata, skipping sports search');
			return [];
		}

		// Dynamic fallback: match query words against sport codes from the /sports endpoint.
		// This covers 80+ sports not in SPORT_ALIASES (rugby, lacrosse, f1, etc.) without
		// requiring a manually maintained exhaustive alias list.
		if (detectedSports.length === 0) {
			const queryWords = lowerQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
			const dynamic: string[] = [];
			for (const entry of sportsMeta) {
				const code = entry.sport.toLowerCase();
				// Word-match only — avoids false positives like "sc" in "gentzsch"
				if (queryWords.includes(code)) {
					dynamic.push(code);
				}
			}
			if (dynamic.length > 0) {
				console.log(`[search] Dynamic sport detection: ${dynamic.join(', ')}`);
				detectedSports = dynamic;
			}
		}

		// Cricket country-name detection: if query mentions country names that
		// are commonly associated with cricket (Malaysia, Bahrain, Nepal, etc.),
		// search ALL cricket-tagged sports. This catches international cricket
		// matches whose slugs use ISO country codes (mys, bhr, etc.) that
		// aren't in SPORT_ALIASES.
		if (detectedSports.length === 0) {
			const CRICKET_TAG_ID = '517';
			const queryWords = lowerQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
			const hasCricketCountry = queryWords.some(w => COUNTRY_TO_SLUG_CODE[w] !== undefined);
			if (hasCricketCountry) {
				const cricketSports = sportsMeta
					.filter(s => s.tags.includes(CRICKET_TAG_ID))
					.map(s => s.sport);
				if (cricketSports.length > 0) {
					console.log(`[search] Cricket country detected, searching cricket sports: ${cricketSports.join(', ')}`);
					detectedSports = cricketSports;
				}
			}
		}

		// If still no sport detected, require a vs-query to continue.
		if (detectedSports.length === 0 && !isVsQuery) {
			return [];
		}

		if (detectedSports.length > 0) {
			console.log(`[search] Sports detected from query: ${detectedSports.join(', ')}`);
		} else if (!isVsQuery) {
			// No sport detected AND not a vs-query — can't do anything useful.
			console.log('[search] No sport detected and not a vs-query, skipping sports search');
			return [];
		} else {
			console.log('[search] No sport detected — vs-query, will try all sports series (shallow)');
		}

		// When a specific sport was detected, search only that sport's series.
		// For unknown vs-queries (no sport detected), search ALL sports from the
		// /sports endpoint (dynamically). Priority sports are listed first for
		// early-exit optimization (the loop breaks on first match).
		const PRIORITY_SPORT_CODES = new Set([
			// Esports — highest vs-query volume
			'cs2', 'lol', 'dota2', 'val', 'mlbb', 'ow', 'codmw', 'rl', 'sc2', 'sc', 'pubg',
			'lcs', 'lpl', 'r6siege', 'wildrift',
			// Big 4 North American
			'nba', 'nfl', 'nhl', 'mlb', 'wnba', 'ncaab', 'cfb',
			// Soccer
			'epl', 'lal', 'bun', 'sea', 'ucl', 'uel', 'mls', 'fifa',
			'fl1', 'ere', 'arg', 'bra', 'por', 'mex', 'spl', 'tur',
			'jap', 'kor', 'nor', 'efl', 'ssc',
			// Combat / Racket / Other
			'ufc', 'zuffa', 'atp', 'wta',
			// Cricket (including international and domestic sub-leagues)
			'ipl', 'odi', 't20', 'test', 'kbo', 'wbc',
			'crint', 'crind', 'craus', 'creng', 'crpak', 'crsou', 'crnew', 'cruae',
			'crban', 'cricipl', 'cricpsl', 'criccpl', 'cricsm', 'cricsa20',
			'cricbbl', 'crict20blast', 'cricbpl', 'crict20lpl', 'cricilt20',
			'cricmlc', 'cricss', 'crichkt20w', 'cricpakt20cup', 'cricps',
			// Rugby
			'ruprem', 'rutopft', 'rusixnat', 'ruurc', 'rusrp',
			// Hockey
			'khl', 'shl', 'ahl', 'cehl', 'dehl', 'snhl',
			// Olympics / other
			'mwoh', 'euroleague',
		]);
		// Build the full list: priority sports first, then any remaining from the
		// live /sports endpoint so newly added sports are automatically covered.
		const allApiCodes = sportsMeta.map(s => s.sport);
		const remainingCodes = allApiCodes.filter(c => !PRIORITY_SPORT_CODES.has(c));
		const COMMON_SPORT_CODES = [...PRIORITY_SPORT_CODES, ...remainingCodes];
		const sportsToSearch = detectedSports.length > 0 ? detectedSports : COMMON_SPORT_CODES;

		// Fuzzy abbreviation matcher: checks if keyword is formed by concatenating
		// leading characters from consecutive haystack words.
		// e.g. "chsou" matches "charleston-southern" (ch + sou),
		//      "winth" matches "winthrop" (winth prefix).
		// Guards: keyword ≥3 chars, each word contributes ≥1 char.
		const fuzzySlugMatch = (kw: string, haystack: string): boolean => {
			if (kw.length < 3) return false;
			const words = haystack.split(/[^a-z0-9]+/).filter(w => w.length > 0);
			for (let startIdx = 0; startIdx < words.length; startIdx++) {
				let kwPos = 0;
				let wordsUsed = 0;
				for (let wi = startIdx; wi < words.length && kwPos < kw.length; wi++) {
					const word = words[wi];
					// Try to consume as many keyword chars as possible from this word's prefix
					let consumed = 0;
					while (consumed < word.length && kwPos < kw.length && word[consumed] === kw[kwPos]) {
						consumed++;
						kwPos++;
					}
					if (consumed === 0) break; // word didn't contribute — stop
					wordsUsed++;
				}
				// All keyword chars consumed, used ≥1 word(s)
				if (kwPos === kw.length && wordsUsed >= 1) return true;
			}
			return false;
		};

		// Use shared stopwords + sport/league-specific extras
		const SPORTS_EXTRA_STOPWORDS = new Set([
			'win', 'score', 'rn', 'currently', 'today', 'tonight',
			'up', 'bring', 'chance', 'chances', 'on', 'at', 'to', 'be',
			// sport/league words
			'lol', 'lck', 'lpl', 'lec', 'lcs', 'nba', 'nfl', 'mlb', 'nhl', 'cs2', 'val',
			'esports', 'sports', 'season', 'match', 'game', 'gaming', 'series',
			'kickoff', 'regular', 'bo3', 'bo5', 'bo1', 'bo2',
			// NOTE: do NOT add 'playoffs', 'tournament', 'cup', 'league' here —
			// those are valid search targets (e.g. "NBA playoffs", "Champions League")
		]);
		const queryKeywords = lowerQuery
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter(w => w.length >= 2 && !COMMON_STOPWORDS.has(w) && !SPORTS_EXTRA_STOPWORDS.has(w));

		// Expand full team names to abbreviations (e.g., "JD Gaming" → "jdg")
		// so keywords can match event slugs like `lol-jdg-blg-2026-03-04`.
		for (const [fullName, abbr] of Object.entries(TEAM_ABBREVIATIONS)) {
			if (lowerQuery.includes(fullName) && !queryKeywords.includes(abbr)) {
				queryKeywords.push(abbr);
			}
		}

		// Expand country names to ISO slug codes (e.g., "Malaysia" → "mys")
		// so keywords can match event slugs like `crint-mys-bhr-2026-03-10`.
		for (const kw of [...queryKeywords]) {
			const code = COUNTRY_TO_SLUG_CODE[kw];
			if (code && !queryKeywords.includes(code)) {
				queryKeywords.push(code);
			}
		}

		console.log(`[search] Series search keywords: ${queryKeywords.join(', ')}`);

		// For vs-queries ("X vs Y"), split by "vs" and require BOTH teams
		// to have at least one keyword match. Previously used OR logic for
		// sport-specific queries, but that causes false positives when
		// generic words like "gaming" match many event titles.
		let matchEvent: (haystack: string) => boolean;
		if (isVsQuery) {
			const vsParts = lowerQuery.split(/\s+vs\.?\s+/);
			const leftRaw = (vsParts[0] ?? '')
				.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
				.filter(w => w.length >= 2 && !COMMON_STOPWORDS.has(w) && !SPORTS_EXTRA_STOPWORDS.has(w));
			const rightRaw = (vsParts.slice(1).join(' '))
				.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
				.filter(w => w.length >= 2 && !COMMON_STOPWORDS.has(w) && !SPORTS_EXTRA_STOPWORDS.has(w));

			// Inject team abbreviations into left/right keyword sets
			const leftText = (vsParts[0] ?? '').toLowerCase();
			const rightText = (vsParts.slice(1).join(' ')).toLowerCase();
			for (const [fullName, abbr] of Object.entries(TEAM_ABBREVIATIONS)) {
				if (leftText.includes(fullName) && !leftRaw.includes(abbr)) leftRaw.push(abbr);
				if (rightText.includes(fullName) && !rightRaw.includes(abbr)) rightRaw.push(abbr);
			}

			const leftKws = leftRaw;
			const rightKws = rightRaw;
			console.log(`[search] VS split — left: [${leftKws}], right: [${rightKws}]`);
			matchEvent = (h: string) => {
				// Use prefix-aware matching (\b at start only) so "warrior" matches "warriors",
				// "clipper" matches "clippers", etc. Leading \b prevents "jd" matching in "mjd".
				// Falls back to fuzzy slug match for abbreviated team names (e.g. "chsou" → "charleston-southern").
				const kwMatch = (kw: string, hay: string) =>
					new RegExp('\\b' + kw).test(hay) || fuzzySlugMatch(kw, hay);
				const lMatch = leftKws.length > 0 && leftKws.some(kw => kwMatch(kw, h));
				const rMatch = rightKws.length > 0 && rightKws.some(kw => kwMatch(kw, h));
				// Always require BOTH teams to match — prevents false positives
				// from generic words like "gaming" matching unrelated events
				return lMatch && rMatch;
			};
		} else {
			matchEvent = (h: string) => queryKeywords.every(kw =>
				new RegExp('\\b' + kw + '\\b').test(h) || fuzzySlugMatch(kw, h));
		}
		// Normalize accents in haystacks before matching to prevent false positives
		// like \btom\b matching "Tomé" (accent é is \W, creating a word boundary).
		const normHaystack = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

		if (queryKeywords.length > 0) {
			const seriesDeduped = new Map<string, Market>();
			const seriesMarkets: Market[] = [];

			for (const sportCode of sportsToSearch) {
				const entry = sportsMeta.find(s => s.sport === sportCode);
				if (!entry?.series) continue;

				const seriesIds = entry.series.split(',').map(s => s.trim()).filter(Boolean);
				for (const seriesId of seriesIds.slice(0, 2)) { // max 2 series per sport
					// Paginate deeper when a specific sport was detected (only 1-2 series);
					// shallow when scanning all sports (no sport detected, ~50 sports).
					const isSpecificSport = detectedSports.length > 0;
					const MAX_OFFSET = isSpecificSport ? 180 : 20;
					for (let offset = 0; offset <= MAX_OFFSET; offset += 20) {
						try {
							const url = `${GAMMA_API_BASE}/events?series_id=${seriesId}&closed=false&limit=20&offset=${offset}`;
							const resp = await fetch(url);
							if (!resp.ok) break;

							const events = await resp.json() as Array<{
								title?: string;
								slug?: string;
								markets?: GammaMarketResponse[];
							}>;
							if (!Array.isArray(events) || events.length === 0) break;

							for (const event of events) {
								if (!Array.isArray(event.markets)) continue;

								// Match against the event SLUG (uses abbreviations like "ktc", "drxc")
								// OR fall back to matching the title.
								// REQUIRE ALL keywords to match (not just any one) to avoid returning
								// hundreds of irrelevant events when query contains common words.
								const eventSlug = (event.slug ?? '').toLowerCase();
								const eventTitle = (event.title ?? '').toLowerCase();
								const haystack = normHaystack(eventSlug + ' ' + eventTitle);
								// Use either-team matching for vs-queries (one team may be abbreviated in slug/title),
								// all-keywords matching for other queries (avoids returning unrelated events).
								if (!matchEvent(haystack)) continue;

								console.log(`[search] Series hit: "${event.title}" (slug=${event.slug})`)
								for (const raw of event.markets) {
									const m = mapGammaMarketToMarket(raw);
									if (m && !seriesDeduped.has(m.id)) {
										seriesDeduped.set(m.id, m);
										seriesMarkets.push(m);
									}
								}
							}

							if (events.length < 20) break; // last page
						} catch {
							break;
						}
					}
				}

				// Also check recent closed events in case the match just ended
				if (seriesMarkets.length === 0) {
					for (const seriesId of seriesIds.slice(0, 1)) {
						for (let offset = 0; offset <= 20; offset += 20) {
							try {
								const url = `${GAMMA_API_BASE}/events?series_id=${seriesId}&closed=true&limit=20&offset=${offset}`;
								const resp = await fetch(url);
								if (!resp.ok) break;

								const events = await resp.json() as Array<{
									title?: string;
									slug?: string;
									markets?: GammaMarketResponse[];
								}>;
								if (!Array.isArray(events) || events.length === 0) break;

								for (const event of events) {
									if (!Array.isArray(event.markets)) continue;
									const eventSlug = (event.slug ?? '').toLowerCase();
									const eventTitle = (event.title ?? '').toLowerCase();
									const haystack = normHaystack(eventSlug + ' ' + eventTitle);
									if (!matchEvent(haystack)) continue;
									console.log(`[search] Series (closed) hit: "${event.title}"`);
									for (const raw of event.markets) {
										const m = mapGammaMarketToMarket(raw);
										if (m && !seriesDeduped.has(m.id)) {
											seriesDeduped.set(m.id, m);
											seriesMarkets.push(m);
										}
									}
								}
								if (events.length < 20) break;
							} catch {
								break;
							}
						}
					}
				}

				// Early exit: stop scanning remaining sports as soon as we find a match.
				// Critical for all-sports scans to avoid 150+ unnecessary API calls.
				if (seriesMarkets.length > 0) break;
			}

			if (seriesMarkets.length > 0) {
				// Extract YYYY-MM-DD from event slug (e.g. lol-jdg-blg-2026-03-04 → "2026-03-04")
				// so we can prefer the most recent event when multiple same-team matchups exist.
				const slugDate = (m: Market): string =>
					m.eventSlug?.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? '0000-00-00';
				seriesMarkets.sort((a, b) => {
					const rank = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
					const statusDiff = rank(a.status) - rank(b.status);
					if (statusDiff !== 0) return statusDiff;
					// Tiebreaker 1: most recent event first (so today's live match beats Feb 28)
					const dateDiff = slugDate(b).localeCompare(slugDate(a));
					if (dateDiff !== 0) return dateDiff;
					// Tiebreaker 2: highest volume first — ensures the winner/moneyline market
					// sorts above low-volume O/U or spread markets from the same event.
					return (b.volume || 0) - (a.volume || 0);
				});
				console.log(`[search] Series search found ${seriesMarkets.length} markets for "${query}"`);
				return seriesMarkets;
			}
		}

		// --- Strategy 2: Tag-based search (general sport queries) ---
		// Build a frequency map to skip broad/generic tags
		const tagFrequency = new Map<string, number>();
		for (const entry of sportsMeta) {
			for (const tagId of entry.tags.split(',')) {
				const t = tagId.trim();
				if (t) tagFrequency.set(t, (tagFrequency.get(t) ?? 0) + 1);
			}
		}
		const GENERIC_TAG_THRESHOLD = 10;

		const tagIds = new Set<string>();
		for (const sportCode of detectedSports) {
			const entry = sportsMeta.find(s => s.sport === sportCode);
			if (entry) {
				for (const tagId of entry.tags.split(',')) {
					const trimmed = tagId.trim();
					if (!trimmed) continue;
					const freq = tagFrequency.get(trimmed) ?? 0;
					if (freq < GENERIC_TAG_THRESHOLD) tagIds.add(trimmed);
				}
			}
		}

		if (tagIds.size === 0) {
			console.log('[search] No specific tags found, skipping tag search');
			return [];
		}

		const sportKeywords: string[] = [];
		for (const sportCode of detectedSports) {
			sportKeywords.push(sportCode);
			const aliases = SPORT_ALIASES[sportCode];
			if (aliases) sportKeywords.push(...aliases.filter(a => a.length > 2));
		}

		const allMarkets: Market[] = [];
		const deduped = new Map<string, Market>();

		for (const tagId of [...tagIds].slice(0, 3)) {
			try {
				const eventUrl = `${GAMMA_API_BASE}/events?tag_id=${tagId}&closed=false&limit=50&active=true`;
				const resp = await fetch(eventUrl);
				if (!resp.ok) continue;

				const events = await resp.json() as Array<{ title?: string; markets?: GammaMarketResponse[] }>;
				if (!Array.isArray(events)) continue;

				for (const event of events) {
					if (!Array.isArray(event.markets)) continue;
					// tag_id already guarantees sport relevance — don't additionally filter
					// by sport keyword (drops valid events like "NAVI vs FaZe" that have no
					// "cs2" in the title). Instead, if we have specific query keywords,
					// match events to the query using the same matchEvent logic.
					if (queryKeywords.length > 0) {
						const eventTitle = (event.title ?? '').toLowerCase();
						const eventSlug = ((event as { slug?: string }).slug ?? '').toLowerCase();
						const haystack = eventSlug + ' ' + eventTitle;
						if (!matchEvent(haystack)) continue;
					}
					console.log(`[search] Tag event: "${event.title}" (${event.markets.length} markets)`);
					for (const raw of event.markets) {
						const m = mapGammaMarketToMarket(raw);
						if (m && !deduped.has(m.id)) {
							deduped.set(m.id, m);
							allMarkets.push(m);
						}
					}
				}
			} catch {
				// best-effort; skip this tag
			}
		}

		// Sort: active first, then keyword relevance score (matches query keywords),
		// then volume. This ensures e.g. "NBA playoffs" ranks playoff markets above
		// high-volume season-award markets.
		const tagScoreOf = (m: Market): number => {
			if (queryKeywords.length === 0) return 0;
			const q = m.question.toLowerCase();
			return queryKeywords.filter(kw => q.includes(kw)).length;
		};
		allMarkets.sort((a, b) => {
			const rank = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
			const statusDiff = rank(a.status) - rank(b.status);
			if (statusDiff !== 0) return statusDiff;
			const scoreDiff = tagScoreOf(b) - tagScoreOf(a);
			if (scoreDiff !== 0) return scoreDiff;
			return b.volume - a.volume;
		});

		const activeCount = allMarkets.filter(m => m.status === 'active').length;
		console.log(`[search] Tag search: ${allMarkets.length} total markets, ${activeCount} active`);

		// For specific vs-queries (e.g. "Clippers vs Warriors", "T1 vs NAVI"), filter down to
		// markets whose question contains ALL of the team/player keywords (strict match).
		// Prevents unrelated markets (e.g. "NAVI vs B8" for "T1 vs NAVI").
		if (isVsQuery && queryKeywords.length > 0) {
			// Include short team codes (e.g. "t1", "g2") — allow length ≥2
			const filterKws = queryKeywords.filter(kw => kw.length >= 2);
			if (filterKws.length > 0) {
				// Strict: ALL keywords must appear in the question
				const strictFiltered = allMarkets.filter(m => {
					const q = m.question.toLowerCase();
					return filterKws.every(kw => q.includes(kw));
				});
				if (strictFiltered.length > 0) {
					console.log(`[search] vs-query strict filter: ${allMarkets.length} → ${strictFiltered.length} (all: ${filterKws.join(', ')})`);
					return strictFiltered;
				}
				// Strict found nothing. Try loose with long keywords (≥5 chars) for
				// team names like "clippers" where individual team futures are useful.
				// Skip loose for short codes (t1, g2) to avoid unrelated picks.
				const longKws = filterKws.filter(kw => kw.length >= 5);
				if (longKws.length > 0) {
					const looseFiltered = allMarkets.filter(m => {
						const q = m.question.toLowerCase();
						return longKws.some(kw => q.includes(kw));
					});
					if (looseFiltered.length > 0) {
						console.log(`[search] vs-query loose filter: ${allMarkets.length} → ${looseFiltered.length} (any: ${longKws.join(', ')})`);
						return looseFiltered;
					}
				}
				// Nothing found — this matchup has no Polymarket market
				console.log(`[search] vs-query filter: no matching markets for this matchup, returning empty`);
				return [];
			}
		}

		return allMarkets;
	}

	/**
	 * Searches events by generating slug candidates from cleaned keywords
	 * and trying them against the Gamma /events endpoint.
	 * This is a broader search than the initial slug search because it uses
	 * noise-filtered keywords.
	 */
	private async searchEventsByText(cleanedQuery: string): Promise<Market[]> {
		const slugCandidates = buildEventSlugCandidates(cleanedQuery);
		console.log(`[search] Events text search slug candidates:`, slugCandidates.slice(0, 5));

		for (const scope of ['closed=false', 'closed=true']) {
			for (const slug of slugCandidates) {
				try {
					const url = `${GAMMA_API_BASE}/events?${scope}&limit=3&slug=${encodeURIComponent(slug)}`;
					const resp = await fetch(url);
					if (!resp.ok) continue;
					const events = await resp.json();
					if (Array.isArray(events) && events.length > 0) {
						const allMarkets: Market[] = [];
						for (const event of events) {
							if (!Array.isArray(event.markets)) continue;
							console.log(`[search] Events text hit! slug="${slug}" title="${event.title}" markets=${event.markets.length}`);
							for (const raw of event.markets) {
								const m = mapGammaMarketToMarket(raw);
								if (m) allMarkets.push(m);
							}
						}
						if (allMarkets.length > 0) return allMarkets;
					}
				} catch {
					// best-effort; try next slug
				}
			}
		}

		// Fallback: events text_query search — catches events where the slug doesn't
		// match any of our candidates (e.g. "will-jayson-tatum-play-a-game-this-season").
		// IMPORTANT: filter by keyword relevance — the events text_query API can return
		// popular unrelated events if the specific query term isn't found.
		const textQueryKeywords = cleanedQuery
			.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
			.filter(w => w.length >= 3 && /[a-z]/.test(w) &&
				!new Set(['the', 'for', 'will', 'who', 'what', 'and', 'market', 'about', 'this', 'that']).has(w));
		if (textQueryKeywords.length > 0) {
			try {
				const url = `${GAMMA_API_BASE}/events?closed=false&limit=5&text_query=${encodeURIComponent(cleanedQuery)}`;
				const resp = await fetch(url);
				if (resp.ok) {
					const events = await resp.json();
					if (Array.isArray(events)) {
						const allMarkets: Market[] = [];
						for (const event of events) {
							if (!Array.isArray(event.markets)) continue;
							// Only accept events whose title is relevant to the query
							const title = (event.title ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
							const titleRelevant = textQueryKeywords.some(kw => title.includes(kw));
							if (!titleRelevant) {
								console.log(`[search] Events text_query: skipping irrelevant event "${event.title}"`);
								continue;
							}
							console.log(`[search] Events text_query hit: "${event.title}" (${event.markets.length} markets)`);
							for (const raw of event.markets) {
								const m = mapGammaMarketToMarket(raw);
								if (m) allMarkets.push(m);
							}
						}
						if (allMarkets.length > 0) return allMarkets;
					}
				}
			} catch {
				// best-effort
			}
		}

		return [];
	}

	/**
	 * Scores and sorts event markets using TF-IDF weighted keyword matching.
	 * Shared between player override results, slug results, and text_query results.
	 */
	private scoreAndSortEventMarkets(markets: Market[], searchTerms: string): Market[] {
		const scoreKeywords = searchTerms
			.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
			.filter(w => w.length >= 2 && !COMMON_STOPWORDS.has(w));

		markets.sort((a, b) => {
			const rankStatus = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
			const statusDiff = rankStatus(a.status) - rankStatus(b.status);
			if (statusDiff !== 0) return statusDiff;
			const scoreDiff = tfidfScore(b, scoreKeywords, markets) - tfidfScore(a, scoreKeywords, markets);
			if (scoreDiff !== 0) return scoreDiff;
			return Math.log10(Math.max(b.volume || 1, 1)) - Math.log10(Math.max(a.volume || 1, 1));
		});

		const activeCount = markets.filter(m => m.status === 'active').length;
		console.log(`[search] Event results: ${markets.length} total, ${activeCount} active. Top: "${markets[0]?.question}"`);
		return markets;
	}
}


/**
 * TF-IDF scoring: weights rare keywords higher than common ones.
 * score += 1 / log2(1 + df) per keyword hit, where df = how many documents contain that keyword.
 * This ensures that "Newsom" (rare) scores much higher than "president" (common).
 */
function tfidfScore(market: { question: string }, keywords: string[], corpus: { question: string }[]): number {
	if (keywords.length === 0) return 0;
	const q = market.question.toLowerCase();
	let score = 0;
	for (const kw of keywords) {
		if (!q.includes(kw)) continue;
		// Document frequency: how many markets in the corpus contain this keyword
		const df = corpus.filter(m => m.question.toLowerCase().includes(kw)).length;
		// IDF weight: rare keywords get higher weight
		score += 1 / Math.log2(1 + Math.max(df, 1));
	}
	// Phrase bonus: if the first 4 keywords appear consecutively, add a bonus
	const phrase = keywords.slice(0, 4).join(' ');
	if (phrase.length >= 5 && q.includes(phrase)) score += 2;
	return score;
}

/**
 * Fetches the /sports metadata from the Gamma API with in-memory caching.
 */

/**
 * Ranks markets by volume (higher = better), with active markets first.
 * Applied to all fallback results to surface the most interesting markets.
 */
function rankMarkets(markets: Market[]): Market[] {
	return markets.sort((a, b) => {
		const rankStatus = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
		const statusDiff = rankStatus(a.status) - rankStatus(b.status);
		if (statusDiff !== 0) return statusDiff;
		const volScore = (m: Market) => Math.log10(Math.max(m.volume || 1, 1));
		return volScore(b) - volScore(a);
	});
}

/**
 * Cleans search keywords by removing conversational noise words.
 * Produces a clean topic string suitable for API queries.
 *
 * Example: "Presidential Election Winner 2028 market condition of JD Vance"
 *       → "Presidential Election Winner 2028 JD Vance"
 */
function cleanSearchKeywords(query: string): string {
	// Use shared stopwords + a few extra words specific to keyword cleaning
	const CLEAN_EXTRA = new Set(['condition', 'today', 'tonight', 'latest']);

	const words = query.trim().split(/\s+/);
	const cleaned = words.filter(w => {
		const lower = w.toLowerCase().replace(/[^a-z0-9]/g, '');
		return lower.length >= 2 && !COMMON_STOPWORDS.has(lower) && !CLEAN_EXTRA.has(lower);
	});

	// If aggressive cleaning removed too much, fall back to original
	if (cleaned.length < 2) return query.trim();
	return cleaned.join(' ');
}
async function fetchSportsMetadata(): Promise<SportEntry[]> {
	if (sportsCache && Date.now() < sportsCacheExpiresAt) {
		return sportsCache;
	}

	try {
		const resp = await fetch(`${GAMMA_API_BASE}/sports`);
		if (!resp.ok) {
			console.log(`[sports] Failed to fetch /sports: ${resp.status}`);
			return sportsCache ?? [];
		}

		const data = await resp.json() as SportEntry[];
		if (Array.isArray(data)) {
			sportsCache = data;
			sportsCacheExpiresAt = Date.now() + SPORTS_CACHE_TTL_MS;
			console.log(`[sports] Cached ${data.length} sports entries`);
			return data;
		}
	} catch (err) {
		console.log(`[sports] Error fetching /sports: ${err}`);
	}

	return sportsCache ?? [];
}

/**
 * Detects sport/esports categories from a user query by matching
 * against known aliases and team names.
 * Returns an array of sport codes (e.g. ['lol', 'cs2']).
 */
function detectSportsFromQuery(query: string): string[] {
	const lower = query.toLowerCase();
	const words = lower.replace(/[^a-z0-9\s.]/g, ' ').split(/\s+/).filter(Boolean);
	const matches: string[] = [];

	for (const [sportCode, aliases] of Object.entries(SPORT_ALIASES)) {
		for (const alias of aliases) {
			// Check if the alias appears in the query as a whole word or substring
			if (alias.includes(' ')) {
				// Multi-word alias: check as substring
				if (lower.includes(alias)) {
					if (!matches.includes(sportCode)) matches.push(sportCode);
					break;
				}
			} else {
				// Single-word alias: check as exact word match
				if (words.includes(alias)) {
					if (!matches.includes(sportCode)) matches.push(sportCode);
					break;
				}
			}
		}
	}

	// If the query contains a "vs" pattern, try matching query WORDS
	// against known sport aliases as whole words.
	// (Previously used 3-char prefix matching which caused 'live' → 'liverpool' → EPL)
	if (matches.length === 0 && (lower.includes(' vs ') || lower.includes(' versus '))) {
		const queryWords = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
		for (const [sportCode, aliases] of Object.entries(SPORT_ALIASES)) {
			for (const alias of aliases) {
				// Only match single-word aliases as exact word matches
				if (!alias.includes(' ') && queryWords.includes(alias)) {
					if (!matches.includes(sportCode)) matches.push(sportCode);
					break;
				}
			}
			if (matches.length > 0) break;
		}
	}

	return matches;
}

/**
 * Uses Gemini to extract the core topic/search keywords from a conversational
 * Discord message. Falls back to simple prefix stripping if AI is unavailable.
 *
 * Example: "tell me about US strikes Iran by...?" → "US strikes Iran by"
 * Example: "what about Democratic Presidential Nominee 2028" → "Democratic Presidential Nominee 2028"
 */
async function extractSearchKeywords(message: string): Promise<string> {
	// Always run prefix stripping first — removes conversational framing.
	// For "X vs Y" queries this already gives perfect keywords; return immediately.
	// For everything else use it as a pre-processing step before AI.
	const stripped = stripConversationalPrefix(message);
	const isVsQuery = /\b(vs\.?|versus)\b/i.test(stripped) && stripped.split(/\s+/).length <= 6;
	if (isVsQuery) {
		console.log(`[extractSearchKeywords] vs-match strip: "${stripped}"`);
		return stripped;
	}

	// Short results after stripping (≤5 words) need no further cleanup.
	const strippedWords = stripped.trim().split(/\s+/).length;
	if (strippedWords <= 5) {
		console.log(`[extractSearchKeywords] Short after strip, using: "${stripped}"`);
		return stripped;
	}

	// For longer queries, run AI on the already-stripped string so it only
	// needs to remove residual noise (e.g. "of Gavin Newsom" → clean topic).
	if (!hasGeminiKeys()) {
		return stripped;
	}

	try {
		const text = await callGemini({
			contents: stripped,    // use pre-stripped string — less noise for AI
			systemInstruction: [
				'Extract the core topic or search keywords from the user message.',
				'Return ONLY the keywords — no explanation, no quotes, no punctuation except what is part of the topic name.',
				'Remove conversational words like "tell me about", "what is", "current status", "live status", etc.',
				'Keep team names, abbreviations, and specific identifiers EXACTLY as the user wrote them.',
				'Examples:',
				'  "tell me about US strikes Iran by...?" → US strikes Iran by',
				'  "what about Democratic Presidential Nominee 2028" → Democratic Presidential Nominee 2028',
				'  "show me the trump deportation markets" → trump deportation',
				'  "current live status of KTC vs DRXC market" → KTC vs DRXC',
				'  "hi can you check about KTC vs DRXC market" → KTC vs DRXC',
				'  "what are the lakers celtics odds" → lakers celtics',
				'  "what\'s trending right now?" → ',
				'  "anything interesting today?" → ',
				'  "show me politics" → politics',
				'  "what\'s happening in crypto?" → crypto',
				'  "any new markets?" → ',
				'If the message is vague with no specific topic (e.g. "what\'s hot?", "anything interesting?"), return an EMPTY string.',
				'If the message asks about a category (politics, crypto, sports, etc.), return just that category word.',
			].join('\n'),
			temperature: 0,
			maxOutputTokens: 50,
		});

		// Validate AI output — reject if it dropped important entities from the input
		if (text && text.length >= 2 && text.length < 200) {
			const inputWords = stripped.trim().split(/\s+/).filter(w => w.length > 2);
			const outputWords = text.trim().split(/\s+/);

			// Reject: multi-word input collapsed to a single token (too aggressive)
			const tooAggressive = inputWords.length >= 4 && outputWords.length === 1;
			if (tooAggressive) {
				console.log('[extractSearchKeywords] AI collapsed too much, using stripped');
				return stripped;
			}

			// Reject: AI dropped proper nouns (capitalized words like "Gavin", "Newsom", "Sanders")
			// These are the most important search terms and must never be silently removed.
			const inputProperNouns = stripped.split(/\s+/).filter(w => /^[A-Z][a-z]{1,}/.test(w));
			const outputLower = text.toLowerCase();
			const droppedProperNoun = inputProperNouns.some(noun => !outputLower.includes(noun.toLowerCase()));
			if (inputProperNouns.length > 0 && droppedProperNoun) {
				console.log(`[extractSearchKeywords] AI dropped proper nouns (${inputProperNouns.join(', ')}), using stripped`);
				return stripped;
			}

			return text;
		}
	} catch (err) {
		console.log(`[extractSearchKeywords] AI call failed: ${err}`);
	}

	return stripped; // fallback to prefix-stripped version if AI fails or returns invalid
}

/**
 * Combined AI call that extracts search keywords AND predicts likely Polymarket
 * event slug fragments in a single round-trip. This replaces the previous
 * two-step process (keywords first, then mechanical slug permutations only).
 *
 * For short / vs-queries where AI isn't needed, returns immediately without
 * any network call. Falls back gracefully when AI is unavailable.
 */
async function extractKeywordsAndSlugs(message: string): Promise<{ keywords: string; slugPredictions: string[] }> {
	const stripped = stripConversationalPrefix(message);

	// For very short queries (1 word), skip AI — not enough context for useful slug predictions
	const strippedWords = stripped.trim().split(/\s+/).length;
	if (strippedWords <= 1) {
		console.log(`[extractKeywordsAndSlugs] Single-word query, using stripped: "${stripped}"`);
		return { keywords: stripped, slugPredictions: [] };
	}

	if (!hasGeminiKeys()) {
		return { keywords: stripped, slugPredictions: [] };
	}

	try {
		const raw = await callGemini({
			contents: stripped,
			systemInstruction: [
				'Given a search query, return a JSON object with two fields:',
				'  "keywords": the core topic (remove conversational words like "tell me about", "what is", "show me the", "current status"; keep proper names, numbers, years exactly)',
				'  "slugs": array of 3-5 predicted Polymarket event slug fragments',
				'',
				'Polymarket slug format: lowercase, hyphen-separated, no articles/prepositions.',
				'Patterns: yes/no events start with "will-"; include the main action verb; use FULL proper names.',
				'',
				'Return ONLY valid JSON. No explanation.',
				'',
				'Examples:',
				'{"keywords":"trump tariff canada","slugs":["will-trump-impose-tariffs-on-canada","trump-canada-tariffs-2025","will-trump-tariff-canada"]}',
				'{"keywords":"bitcoin reach 100k","slugs":["will-bitcoin-hit-100k","will-bitcoin-reach-100000","bitcoin-price-100k-2025"]}',
				'{"keywords":"fed rate cut march","slugs":["will-fed-cut-rates-march","federal-reserve-rate-cut-2025","will-fed-lower-rates"]}',
				'{"keywords":"iran nuclear deal","slugs":["will-iran-sign-nuclear-deal","iran-nuclear-agreement-2025","will-iran-rejoin-jcpoa"]}',
				'{"keywords":"gavin newsom president 2028","slugs":["will-gavin-newsom-run-for-president","gavin-newsom-2028-president","will-gavin-newsom-win-2028"]}',
				'{"keywords":"show me politics","slugs":[]}',
				'{"keywords":"any new markets","slugs":[]}',
			].join('\n'),
			temperature: 0.1,
			maxOutputTokens: 200,
			jsonMode: true,
		});

		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				const kw = typeof parsed.keywords === 'string' && parsed.keywords.trim()
					? parsed.keywords.trim()
					: stripped;

				// Validate keywords — same checks as extractSearchKeywords
				const inputWords = stripped.trim().split(/\s+/).filter(w => w.length > 2);
				const outputWords = kw.split(/\s+/);
				const tooAggressive = inputWords.length >= 4 && outputWords.length === 1;
				const inputProperNouns = stripped.split(/\s+/).filter(w => /^[A-Z][a-z]{1,}/.test(w));
				const droppedProperNoun = inputProperNouns.some(n => !kw.toLowerCase().includes(n.toLowerCase()));
				const safeKeywords = (tooAggressive || (inputProperNouns.length > 0 && droppedProperNoun))
					? stripped
					: kw;

				const slugPredictions = Array.isArray(parsed.slugs)
					? parsed.slugs.filter((s: unknown) => typeof s === 'string' && s.length >= 5).slice(0, 5)
					: [];

				return { keywords: safeKeywords, slugPredictions };
			}
		}
	} catch (err) {
		console.log(`[extractKeywordsAndSlugs] AI call failed: ${err}`);
	}

	return { keywords: stripped, slugPredictions: [] };
}

/**
 * Words that are conversational noise — NOT part of team/event names.
 * Used when extracting team1 from text before "vs".
 */
const VS_STOPWORDS = new Set([
	'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'is', 'are', 'be',
	'hi', 'hey', 'hello', 'can', 'you', 'please', 'about', 'check', 'what',
	'how', 'who', 'which', 'tell', 'me', 'show', 'give', 'find', 'get', 'do',
	'current', 'live', 'status', 'going', 'this', 'that', 'game', 'match',
	'market', 'series', 'will', 'win', 'beat', 'score', 'update', 'info',
	'between', 'and', 'with', 'vs', 'versus', 'right', 'now', 'today',
	'tonight', 'odds', 'predict', 'prediction', 'look', 'like', 'think',
]);

/**
 * Strips conversational noise and extracts search keywords without AI.
 *
 * Priority:
 *   1. "X vs Y" anywhere in the message → returns "X vs Y" (team names only)
 *   2. Known conversational prefix → strip and return rest
 *   3. Returns the original query unchanged (caller can try AI next)
 */
function stripConversationalPrefix(query: string): string {
	const lower = query.toLowerCase().trim();

	// --- Priority 1: "X vs Y" pattern anywhere in the message ---
	// Match both "vs" and "versus", with optional trailing noise
	const vsRe = /\b(vs\.?|versus)\b/i;
	const vsMatch = vsRe.exec(lower);
	if (vsMatch && vsMatch.index !== undefined) {
		const vsIdx = vsMatch.index;
		const vsLen = vsMatch[0].length;

		// Everything before "vs"
		const beforeVs = query.slice(0, vsIdx).trim().split(/\s+/);
		// Everything after "vs", strip trailing noise words
		const afterVsRaw = query.slice(vsIdx + vsLen).trim()
			.replace(/\s*(market|game|match|series|right\s*now|rn|going|today|tonight|\?)\s*$/i, '').trim();

		// Filter stopwords from beforeVs, keep meaningful words (team names, abbreviations)
		const team1Words = beforeVs.filter(w => !VS_STOPWORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
		const team1 = team1Words.slice(-2).join(' ').trim(); // last 1-2 meaningful words

		// Take first 1-2 words after "vs" as team2 (team names are short)
		const team2Words = afterVsRaw.split(/\s+/).filter(w => w.length > 0);
		const team2 = team2Words.slice(0, 2).join(' ').trim();

		if (team1 && team2) {
			return `${team1} vs ${team2}`;
		}
	}

	// --- Priority 2: Known conversational prefixes (longest match first) ---
	const prefixes = [
		// Multi-word specific prefixes first (to prevent partial matches)
		'hi can you check about ', 'hi can you check ',
		'can you tell me about ', 'can you tell me ',
		'can you check about ', 'can you check ',
		'please tell me about ', 'please check ',
		'could you check ', 'could you tell me about ',
		'current live status of ', 'current status of ', 'live status of ',
		'what is the status of ', 'what is the score of ',
		'what are the odds for ', 'what are the odds on ',
		'whats the odds for ', 'whats the odds on ',
		"what's the odds for ", "what's the odds on ",
		'how are the odds for ', 'how are the odds on ',
		'how is this game going', 'how is the game going', 'how is this match going',
		'how is this going', 'how is it going',
		'i want to know about ', 'do you have info on ', 'do you have info about ',
		'info on ', 'info about ', 'any updates on ',
		// Short prefixes last
		'tell me about ', 'what about ', 'what is ', 'what are ',
		"what's ", 'whats ',
		'show me ', 'give me ', 'check on ', 'check about ',
		'how about ', 'who will win ',
	];
	for (const p of prefixes) {
		if (lower.startsWith(p)) {
			let rest = query.slice(p.length).trim()
				.replace(/\s*(market|right\s*now|rn|today|tonight|at the moment|\?)\s*$/i, '').trim();
			// Strip trailing noise like "market condition of X" → keep "X" separate
			rest = rest.replace(/\s+market\s+condition\s+of\b/i, ' ').trim();
			if (rest.length > 0) return rest;
		}
	}

	// --- Priority 3: Strip trailing noise patterns even without a known prefix ---
	let cleaned = query.trim()
		.replace(/\s*(market\s*condition|market|right\s*now|rn|today|tonight|at the moment|\?)\s*$/i, '').trim();
	// Also strip leading noise: "whats" without space, etc.
	cleaned = cleaned.replace(/^(whats|what's)\s+/i, '').trim();
	// Strip " of X" at end if preceded by a topic phrase ("condition of JD Vance" → keep "JD Vance" info)

	if (cleaned.length > 0 && cleaned !== query.trim()) {
		return cleaned;
	}

	return query; // unchanged — caller may try AI
}

/**
 * Builds multiple slug candidates from conversational queries like
 * "tell me about US strikes Iran by...?" so the events endpoint can match.
 *
 * Strategy: generate sliding windows of the ORIGINAL words (not just filtered)
 * so country codes like "US" aren't stripped. Only strip leading conversational
 * prefixes like "tell me about", "what about", etc.
 */
function buildEventSlugCandidates(query: string): string[] {
	const words = query
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // "Rodríguez" → "Rodriguez"
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean);

	const slugify = (tokens: string[]): string =>
		tokens
			.join('-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '');

	// Strip common conversational prefixes
	const prefixes = [
		['tell', 'me', 'about'],
		['what', 'about'],
		['what', 'is'],
		['what', 'are'],
		['whats'],
		['show', 'me'],
		['can', 'you', 'tell', 'me', 'about'],
		['please', 'tell', 'me', 'about'],
		['i', 'want', 'to', 'know', 'about'],
		['do', 'you', 'have', 'info', 'on'],
		['info', 'on'],
		['info', 'about'],
	];

	let stripped = words;
	for (const prefix of prefixes) {
		if (words.length > prefix.length && words.slice(0, prefix.length).join(' ') === prefix.join(' ')) {
			stripped = words.slice(prefix.length);
			break;
		}
	}

	// Filter out noise words to get core topic keywords
	const SLUG_EXTRA = new Set(['condition']);
	const coreWords = stripped.filter(w => w.length >= 2 && !COMMON_STOPWORDS.has(w) && !SLUG_EXTRA.has(w));

	const candidates: string[] = [];
	const add = (s: string) => {
		if (s && s.length >= 3 && !candidates.includes(s)) candidates.push(s);
	};

	// Best candidate: core keywords only (e.g. "presidential-election-winner-2028")
	if (coreWords.length >= 2) {
		add(slugify(coreWords));
	}

	// Stripped query is the next best candidate
	add(slugify(stripped));

	// Sliding windows on ALL stripped words first — these match real Polymarket event
	// slugs better because those slugs keep "of", "the", etc. (e.g. "venezuela-leader-end-of-2026")
	for (let size = Math.min(8, stripped.length); size >= 2; size--) {
		for (let start = 0; start + size <= stripped.length; start++) {
			add(slugify(stripped.slice(start, start + size)));
		}
		if (candidates.length >= 15) break;
	}

	// Sliding windows on CORE words — noise-free variants as additional candidates
	for (let size = Math.min(6, coreWords.length); size >= 2; size--) {
		for (let start = 0; start + size <= coreWords.length; start++) {
			add(slugify(coreWords.slice(start, start + size)));
		}
		if (candidates.length >= 20) break;
	}

	// Try "will-" prefixed versions of top candidates — most Polymarket yes/no
	// event slugs start with "will-" (e.g. "will-messi-play-in-2026-world-cup")
	const topForWill = candidates.slice(0, 6);
	for (const c of topForWill) {
		if (!c.startsWith('will-')) add(`will-${c}`);
	}

	// Try year-first ordering (e.g. "2026-ncaa-tournament-winner" instead of "ncaa-tournament-winner-2026")
	const yearTokens = coreWords.filter(w => /^\d{4}$/.test(w));
	const nonYearCore = coreWords.filter(w => !/^\d{4}$/.test(w));
	if (yearTokens.length > 0 && nonYearCore.length >= 2) {
		add(slugify([...yearTokens, ...nonYearCore]));
		add(slugify([...yearTokens, ...nonYearCore.slice(0, 3)]));
	}

	// Full query slug as last resort
	add(slugify(words));

	// --- Player name expansion ---
	// Many Polymarket slugs use the player's full legal name (e.g. "will-lionel-messi-..."
	// instead of "will-messi-..."). Expand known nicknames/last-names → full names
	// and generate additional slug candidates.
	const PLAYER_EXPANSIONS: Record<string, string[]> = {
		messi: ['lionel', 'messi'],
		ronaldo: ['cristiano', 'ronaldo'],
		neymar: ['neymar'],
		mbappe: ['kylian', 'mbappe'],
		mbapp: ['kylian', 'mbappe'],
		wembanyama: ['victor', 'wembanyama'],
		tatum: ['jayson', 'tatum'],
		lebron: ['lebron', 'james'],
		embiid: ['joel', 'embiid'],
		doncic: ['luka', 'doncic'],
		luka: ['luka', 'doncic'],
		antetokounmpo: ['giannis', 'antetokounmpo'],
		giannis: ['giannis', 'antetokounmpo'],
		jokic: ['nikola', 'jokic'],
		lillard: ['damian', 'lillard'],
		gilgeous: ['shai', 'gilgeous-alexander'],
	};
	for (const [nickname, fullName] of Object.entries(PLAYER_EXPANSIONS)) {
		if (coreWords.includes(nickname)) {
			// Replace the nickname with the full name tokens in core words
			const expanded = coreWords.flatMap(w => w === nickname ? fullName : [w]);
			if (expanded.length !== coreWords.length || expanded.join(' ') !== coreWords.join(' ')) {
				add(slugify(expanded));
				add(`will-${slugify(expanded)}`);
				// Also try with "lionel messi" inserted into other positions
				const expandedWindows = expanded.slice(0, 6);
				add(slugify(expandedWindows));
			}
			break; // one player per query
		}
	}

	return candidates.slice(0, 30);
}

/**
 * Maps a raw Gamma API market response to our internal Market shape.
 * Returns null if the response is malformed or missing required fields.
 */
function mapGammaMarketToMarket(raw: GammaMarketResponse): Market | null {
	const id = raw.conditionId ?? raw.condition_id ?? raw.id;
	const question = raw.question ?? raw.title;
	if (!id || !question) {
		return null;
	}

	const status = resolveMarketStatus(raw);
	const outcomes = parseOutcomes(raw.outcomes);
	const outcomePrices = parseOutcomePrices(raw.outcomePrices, outcomes.length);
	const volume = typeof raw.volume === 'number' ? raw.volume : parseFloat(String(raw.volume ?? '0')) || 0;

	// Derive slug: prefer Gamma API slug, fallback to slugifying the question
	const slug = raw.slug || question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

	// Extract parent event slug for Polymarket event URL (used by Olympus links)
	const eventSlug = raw.events?.[0]?.slug ?? undefined;

	return {
		id: id as MarketId,
		question,
		status,
		outcomes,
		outcomePrices,
		volume,
		slug,
		eventSlug,
	};
}

/**
 * Derives our tri-state status from the Gamma API's boolean flags.
 */
function resolveMarketStatus(raw: GammaMarketResponse): Market['status'] {
	if (raw.closed === true) {
		return 'closed';
	}

	if (raw.active === false || raw.accepting_orders === false) {
		return 'paused';
	}

	return 'active';
}

/**
 * Parses the Gamma API's JSON-encoded outcomes string into typed Outcome array.
 * Falls back to binary ['YES','NO'] if parsing fails (Polymarket default).
 */
/**
 * Parses outcomePrices from the Gamma API into a number array.
 * Falls back to equal probabilities if parsing fails.
 */
function parseOutcomePrices(value: string | string[] | undefined, outcomeCount: number): readonly number[] {
	const fallback = Array(outcomeCount).fill(1 / outcomeCount);
	if (!value) return fallback;

	try {
		const arr: string[] = Array.isArray(value) ? value : JSON.parse(value);
		if (!Array.isArray(arr) || arr.length === 0) return fallback;
		return arr.map(v => parseFloat(v) || 0);
	} catch {
		return fallback;
	}
}

function parseOutcomes(outcomesValue: string | string[] | undefined): readonly Outcome[] {
	if (!outcomesValue) {
		return ['YES', 'NO'];
	}

	const normalize = (arr: string[]): Outcome[] => arr.map((o) => o.toUpperCase() as Outcome);

	if (Array.isArray(outcomesValue)) {
		return normalize(outcomesValue.length > 0 ? outcomesValue : ['YES', 'NO']);
	}

	try {
		const parsed = JSON.parse(outcomesValue) as string[];
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return ['YES', 'NO'];
		}
		return normalize(parsed);
	} catch {
		return ['YES', 'NO'];
	}
}
