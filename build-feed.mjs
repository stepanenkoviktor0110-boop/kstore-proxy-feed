// Proxy-feed для Kstore — обогащает <description> карточек разговорными синонимами,
// чтобы B24U-поиск возвращал товары на формулировки, не совпадающие с <name>.
// SOURCE_FEED_URL=https://kstore.ru/bitrix/catalog_export/export_0fM.xml

import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { writeFileSync, mkdirSync } from 'node:fs';

const SOURCE_FEED_URL = process.env.SOURCE_FEED_URL
  || 'https://kstore.ru/bitrix/catalog_export/export_0fM.xml';
const OUT_PATH = 'public/feed.xml';

// На демо-тарифе B24U лимит 100 товаров. Берём из ~2500 ассортимента по чуть-чуть
// из ключевых категорий И с разбросом по цене (низ/середина/верх), чтобы бот
// мог отвечать на запросы вида «есть наушники беспроводные», «смартфон до 50 000»,
// «недорогой повербанк», «электровелосипед», «робот-пылесос».
// ВАЖНО: порядок имеет значение — более узкие категории идут ПЕРВЫМИ,
// иначе чехлы для iPhone провалятся в bucket «iphone-смартфоны» (т.к. в name есть «iPhone 13»).
const CATEGORY_BUCKETS = [
  { name: 'чехлы-iphone', re: /^чехол|накладка.*iphone/i, picks: 6, budgetSpread: true },
  { name: 'защитное-стекло-плёнка', re: /(защитн.*стекл|защитн.*пленк|hydrogel)/i, picks: 4, budgetSpread: true },
  { name: 'ремешки-часов', re: /ремешок.*(watch|часов|apple watch)/i, picks: 4, budgetSpread: true },
  { name: 'iphone-смартфоны', re: /^apple iphone|^iphone \d/i, picks: 4, budgetSpread: true },
  { name: 'android-смартфоны', re: /смартфон.*(samsung|xiaomi|poco|redmi|honor|huawei|pixel|google|techno|infinix)/i, picks: 6, budgetSpread: true },
  { name: 'apple-watch-и-часы', re: /(apple watch|watch (se|series|ultra)|умные часы|smart watch|fitness band|фитнес.?браслет|amazfit|mi band|honor band)/i, picks: 6, budgetSpread: true },
  { name: 'наушники-беспроводные', re: /(беспровод|wireless|bluetooth|airpods|tws|marshall).*наушник|наушник.*(беспровод|wireless|bluetooth|tws)|airpods|накладн.*наушник.*marshall/i, picks: 6, budgetSpread: true },
  { name: 'наушники-проводные', re: /проводн.*наушник|наушник.*проводн|jack 3\.?5/i, picks: 4, budgetSpread: true },
  { name: 'умный-дом', re: /(умн.*(лампочк|розетк|чайник|выключател|освещен|колонк)|smart.*(bulb|plug|kettle|switch|light)|датчик.*(температур|влажн|микроклимат|открыт|движен|двер)|очистител.*воздух|увлажнител.*воздух|yeelight|aqara|mi home|qcooker|petkit)/i, picks: 8, budgetSpread: true },
  { name: 'пылесосы', re: /(робот.*пылесос|вертикальн.*пылесос|ручн.*пылесос|пылесос|vacuum|roidmi|roborock|mi.?vacuum|dreame|dyson)/i, picks: 6, budgetSpread: true },
  { name: 'электротранспорт-велосипеды', re: /(электровелосипед|e.?bike|электро.?байк)/i, picks: 4, budgetSpread: true },
  { name: 'электротранспорт-самокаты', re: /(электросамокат|e.?scooter|самокат.*электр|ninebot|segway)/i, picks: 4, budgetSpread: true },
  { name: 'квадрокоптеры-vr', re: /(квадрокоптер|drone|dji|vr.?очки|meta.*quest|vr.?шлем|oculus|playstation vr)/i, picks: 4, budgetSpread: true },
  { name: 'тв-проекторы', re: /(телевизор|smart.?tv|проектор|projector|медиаплеер|tv.box)/i, picks: 4, budgetSpread: true },
  { name: 'кабели-зарядки-повербанки', re: /(кабель|зарядк|power.?bank|повербанк|внешн.*аккумул|charger|адаптер.*питан|usb.?хаб)/i, picks: 8, budgetSpread: true },
  { name: 'красота-здоровье', re: /(фен|hair.?dryer|стайлер|триммер|эпилятор|массажёр|массажер|massager|shaver|зубн.*щётк|выпрямител.*волос|плойка)/i, picks: 6, budgetSpread: true },
  { name: 'геймпады-приставки', re: /(геймпад|gamepad|controller|консоль|playstation|xbox|nintendo|джойстик)/i, picks: 4, budgetSpread: true },
  { name: 'аксессуары-разное', re: /(гирлянд|крепление|подставка|чехол.*macbook|чехол.*ipad|чехол.*airpods)/i, picks: 6, budgetSpread: true },
];
const FILTER_ENABLED = process.env.FILTER === '0' ? false : true;
const PRICE_BUCKETS = ['low', 'mid', 'high']; // равные слоты на price-spread

// ───── Словари для Kstore (электроника, гаджеты, электротранспорт) ──────────

// Сопоставление паттерна в name → разговорные синонимы.
// Регексы независимо проверяются по всему названию карточки.
// При совпадении строка из value целиком приписывается в description.
const NAME_PATTERNS = [
  // Смартфоны / телефоны
  { re: /смартфон|iphone|galaxy|pixel|xiaomi.*(redmi|poco|mi)|honor|huawei/i,
    add: 'смартфон телефон мобильный мобила айфон samsung samsung galaxy android ios' },

  // Apple-специфика
  { re: /iphone/i,
    add: 'apple айфон яблочный mac ios iphone' },
  { re: /apple watch|smart watch|умные часы|watch (se|series|ultra)/i,
    add: 'умные часы смарт-часы фитнес-часы носимое устройство wearable' },
  { re: /macbook/i,
    add: 'ноутбук лэптоп macbook apple ноут' },
  { re: /airpods/i,
    add: 'беспроводные наушники bluetooth-наушники tws airpods от apple' },

  // Наушники
  { re: /наушники.+проводн/i,
    add: 'проводные наушники jack 3.5 наушники со штекером с проводом для смартфона' },
  { re: /наушники.+(беспровод|wireless|bluetooth)|накладные.+(naushniki|наушники)/i,
    add: 'беспроводные наушники bluetooth tws накладные затычки внутриканальные' },
  { re: /(marshall|sony|jbl|bose|sennheiser).*(наушник|headphone)/i,
    add: 'беспроводные наушники накладные премиум фирменные с шумодавом' },

  // Аксессуары к телефонам
  { re: /чехол/i,
    add: 'чехол кейс case бампер для телефона защита смартфона' },
  { re: /чехол.*magsafe|magsafe.*чехол/i,
    add: 'чехол с поддержкой magsafe для iphone магнитный беспроводная зарядка' },
  { re: /защитн.*стекл|защитн.*пленк/i,
    add: 'защитное стекло плёнка для экрана пленка на дисплей' },
  { re: /кабель|cable/i,
    add: 'кабель шнур провод для зарядки type-c lightning usb' },
  { re: /зарядк|зарядное|charger|адаптер.*питан/i,
    add: 'зарядное устройство блок питания адаптер power' },
  { re: /power.?bank|повербанк|внешн.*аккум/i,
    add: 'повербанк внешний аккумулятор портативная зарядка power bank' },

  // Умный дом и аксессуары Xiaomi
  { re: /robot.*vacuum|робот.*пылесос|roidmi|roborock|mi.?vacuum/i,
    add: 'робот-пылесос автоматическая уборка xiaomi roborock роборок для дома' },
  { re: /(пылесос|vacuum).*(вертикал|handy|stick)/i,
    add: 'вертикальный пылесос ручной беспроводной пылесос dyson xiaomi' },
  { re: /умн.*лампочк|smart.*bulb|mi.*led/i,
    add: 'умная лампочка smart-лампа управление со смартфона xiaomi yeelight' },
  { re: /умн.*розетк|smart.*plug/i,
    add: 'умная розетка smart-розетка управление по wi-fi mi home' },
  { re: /(датчик|sensor).*(температур|микроклимат|humidity|влажн)/i,
    add: 'датчик температуры и влажности умный дом микроклимат xiaomi' },
  { re: /очистител.*воздух|air.?purifier/i,
    add: 'очиститель воздуха фильтр против аллергии xiaomi smartmi' },
  { re: /чайник.*(умн|smart)/i,
    add: 'умный электрочайник с управлением со смартфона xiaomi qcooker' },

  // Электротранспорт
  { re: /электровелосипед|e-?bike|kugoo.*[vw]|jetson/i,
    add: 'электровелосипед электробайк велик с мотором электро-байк e-bike kugoo' },
  { re: /электросамокат|e-?scooter|самокат.*электр/i,
    add: 'электросамокат электрический самокат e-scooter ninebot xiaomi kugoo' },
  { re: /электротрицикл|cargo.*electric|грузов.*электр/i,
    add: 'грузовой электротрицикл электрическая грузовая тележка для перевозок rutrike' },
  { re: /(самокат|велосипед|байк).*(не.?электро|обычн|складн)/i,
    add: 'обычный самокат складной для города детский подростковый взрослый' },

  // Игровые
  { re: /геймпад|gamepad|controller/i,
    add: 'геймпад джойстик контроллер для игр на смартфоне playstation xbox bluetooth' },
  { re: /квадрокоптер|drone|dji|fpv/i,
    add: 'квадрокоптер дрон коптер летающий с камерой dji радиоуправляемый' },
  { re: /(vr|virtual.*реальн|meta.*quest)/i,
    add: 'vr-очки шлем виртуальной реальности meta quest playstation vr oculus' },

  // Красота и здоровье
  { re: /фен|hair.?dryer|стайлер/i,
    add: 'фен для волос стайлер укладка dyson xiaomi для дома' },
  { re: /(эпилятор|триммер|trimmer|shaver)/i,
    add: 'эпилятор триммер для бороды для тела машинка для стрижки philips xiaomi' },
  { re: /(масс[аа]жер|massager|массаж)/i,
    add: 'массажёр для спины шеи ног прибор для массажа xiaomi' },

  // ТВ и видео
  { re: /(телевизор|tv|smart.*tv)/i,
    add: 'телевизор smart-tv с android на стену для дома lg samsung xiaomi' },
  { re: /(проектор|projector)/i,
    add: 'домашний кинопроектор переносной портативный led 4k mi xiaomi' },
];

// Сопоставление по категории (берётся из <categoryId> или path).
const CATEGORY_HINTS = {
  // Используется если в name недостаточно слов — добавляем из категории.
  // Заполняется после первого прохода: я не знаю реальную category-tree Kstore.
};

// Бренды — пишем как доп. синонимы, чтобы запросы «есть samsung?» находили нужные.
const BRAND_SYNONYMS = {
  apple: 'apple яблочный купертино',
  xiaomi: 'xiaomi сяоми',
  samsung: 'samsung самсунг',
  marshall: 'marshall маршалл',
  hoco: 'hoco хоко',
  dyson: 'dyson дайсон',
  kugoo: 'kugoo кугу',
  philips: 'philips филипс',
  jbl: 'jbl джейбиэль',
  bose: 'bose боуз',
  sony: 'sony сони',
  honor: 'honor хонор',
};

// ───── Утилиты ───────────────────────────────────────────────────────────────

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Source feed fetch failed: ${res.status}`);
  return res.text();
}

function appendUnique(description, addition) {
  if (!addition) return description;
  const desc = String(description ?? '').trim();
  const lcDesc = desc.toLowerCase();
  // не дублируем целиком уже существующее
  if (lcDesc.includes(addition.slice(0, 40).toLowerCase())) return desc;
  return desc ? `${desc}. ${addition}` : addition;
}

function enrichDescription(offer) {
  const name = String(offer['name'] ?? '').trim();
  let desc = String(offer['description'] ?? '').trim();

  // Удаляем дублирующийся блок (фид Kstore содержит content × 2 — раздувает chunks).
  // Эвристика: если description начинается с того же текста, что и vendor + name — обрезаем хвостовой дубль.
  const firstSentence = desc.split(/[.!?\n]/)[0];
  if (firstSentence && firstSentence.length > 20) {
    const secondOccurrence = desc.indexOf(firstSentence, firstSentence.length);
    if (secondOccurrence > 0) {
      desc = desc.slice(0, secondOccurrence).trim().replace(/[.,;]\s*$/, '');
    }
  }

  // Синонимы по name
  const additions = [];
  for (const pat of NAME_PATTERNS) {
    if (pat.re.test(name)) additions.push(pat.add);
  }

  // Бренд
  const vendor = String(offer['vendor'] ?? '').toLowerCase().trim();
  if (vendor && BRAND_SYNONYMS[vendor]) {
    additions.push(BRAND_SYNONYMS[vendor]);
  }

  // Цвет, объём памяти, диагональ — приоритетные структурные поля для поиска
  const param = offer['param'];
  if (Array.isArray(param)) {
    for (const p of param) {
      const k = String(p['@_name'] ?? '').toLowerCase();
      const v = String(p['#text'] ?? p ?? '').trim();
      if (!v) continue;
      if (/(цвет|color)/.test(k)) additions.push(`цвет ${v}`);
      if (/(память|memory|накопител)/.test(k)) additions.push(`${v} памяти встроенная`);
      if (/(диагонал|screen)/.test(k)) additions.push(`диагональ ${v}`);
      if (/(серия|series|model)/.test(k)) additions.push(`серия ${v}`);
    }
  }

  // Удалим из desc телефон менеджера если он там есть — у нас он в Контактах
  desc = desc.replace(/По вопросам заказа звоните:\s*8\s*\(800\)\s*551-?26-?10\s*!?/gi, '').trim();

  for (const add of additions) {
    desc = appendUnique(desc, add);
  }

  // chunks B24U ~900 знаков. Жёстко режем при превышении 850 чтоб не потерять синонимы.
  if (desc.length > 850) {
    desc = desc.slice(0, 850).replace(/[.,;]\s*\S*$/, '').trim();
  }

  return desc;
}

// ───── Основной поток ────────────────────────────────────────────────────────

const xml = await fetchFeed(SOURCE_FEED_URL);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'offer' || name === 'category' || name === 'param' || name === 'picture',
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  suppressBooleanAttributes: false,
});

const feed = parser.parse(xml);

const allOffers = feed?.yml_catalog?.shop?.offers?.offer ?? [];

// Фильтр: отобрать 100 товаров по категориям × ценовым слотам.
// Каждая категория = bucket; внутри bucket берём `picks` товаров с равномерным
// разбросом по price (если budgetSpread=true), иначе просто первые `picks`.
function priceOf(o) {
  const p = parseInt(String(o['price'] ?? '0').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(p) ? p : 0;
}

function pickFromBucket(bucket, name) {
  if (!bucket.budgetSpread || bucket.length <= bucket.picks) {
    return bucket.slice(0, bucket.picks);
  }
  bucket.sort((a, b) => priceOf(a) - priceOf(b));
  const result = [];
  const n = bucket.picks;
  // Равномерное распределение по индексам: low (1/n), mid (k/n), high ((n-1)/n)
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i + 0.5) / n * (bucket.length - 1));
    if (!result.includes(bucket[idx])) result.push(bucket[idx]);
  }
  return result.slice(0, n);
}

let offers;
if (FILTER_ENABLED) {
  const buckets = CATEGORY_BUCKETS.map((c) => ({ ...c, items: [] }));
  const used = new Set();
  for (const o of allOffers) {
    const name = String(o['name'] ?? '');
    for (const b of buckets) {
      if (b.re.test(name)) {
        b.items.push(o);
        used.add(o);
        break;
      }
    }
  }
  // Picks per bucket
  const picked = [];
  const log = [];
  for (const b of buckets) {
    const arr = b.items;
    arr.picks = b.picks;
    arr.budgetSpread = b.budgetSpread;
    const slice = pickFromBucket(arr, b.name);
    picked.push(...slice);
    log.push(`  ${b.name}: ${arr.length} found → ${slice.length} picked${slice.length ? ` (price ${priceOf(slice[0])}–${priceOf(slice[slice.length-1])} ₽)` : ''}`);
  }
  console.log('Category filter:');
  console.log(log.join('\n'));
  // Если общее <100 — добиваем оставшимися товарами с самой популярной price-зоной
  if (picked.length < 100) {
    const left = allOffers.filter(o => !used.has(o));
    left.sort((a, b) => priceOf(a) - priceOf(b));
    const need = 100 - picked.length;
    // равномерный спред
    for (let i = 0; i < need && i < left.length; i++) {
      const idx = Math.round((i + 0.5) / need * (left.length - 1));
      if (!picked.includes(left[idx])) picked.push(left[idx]);
    }
    console.log(`  + filler: ${Math.min(need, left.length)} from remaining ${left.length}`);
  }
  offers = picked.slice(0, 100);
  feed.yml_catalog.shop.offers.offer = offers;
} else {
  offers = allOffers;
}

let touched = 0;
let totalLen = 0;
for (const offer of offers) {
  const before = offer['description'];
  const after = enrichDescription(offer);
  if (after !== before) {
    offer['description'] = after;
    touched++;
  }
  totalLen += String(after ?? '').length;
}

mkdirSync('public', { recursive: true });
writeFileSync(OUT_PATH, builder.build(feed), 'utf-8');

console.log(
  `Done. Offers total: ${offers.length}, enriched: ${touched}, ` +
  `avg description: ${Math.round(totalLen / Math.max(offers.length, 1))} chars. ` +
  `Written to ${OUT_PATH}`
);
