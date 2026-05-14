// Proxy-feed для Kstore — обогащает <description> карточек разговорными синонимами,
// чтобы B24U-поиск возвращал товары на формулировки, не совпадающие с <name>.
//
// v3 (2026-05-14): полный фид, без выборки 100. Тариф B24U поднят с Demo на платный
// без лимита товаров. Buckets/filter/picks/filler удалены — теперь обогащаем ВСЕ
// карточки исходного фида и отдаём как есть. Дедуп Bitrix-блоков и обрезка
// description до 850 знаков сохранены: каждая карточка должна укладываться в один
// chunk B24U (~900 знаков), иначе обогащение нарезается на куски и теряет смысл.
//
// SOURCE_FEED_URL=https://kstore.ru/bitrix/catalog_export/export_0fM.xml

import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { writeFileSync, mkdirSync } from 'node:fs';

const SOURCE_FEED_URL = process.env.SOURCE_FEED_URL
  || 'https://kstore.ru/bitrix/catalog_export/export_0fM.xml';
const OUT_PATH = 'public/feed.xml';

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
  { re: /(самокат|велосипед|байк).*(не.?электро|обычн|складн|трюков|детск|kick)/i,
    add: 'обычный самокат складной для города детский подростковый взрослый трюковый kickscooter' },

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
  if (lcDesc.includes(addition.slice(0, 40).toLowerCase())) return desc;
  return desc ? `${desc}. ${addition}` : addition;
}

function priceZoneSyn(p) {
  if (!p) return '';
  if (p < 1000)    return 'дешевле тысячи до 1000 руб бюджетный';
  if (p < 3000)    return 'до 3000 руб до трёх тысяч недорогой бюджетный';
  if (p < 5000)    return 'до 5000 руб до пяти тысяч недорогой';
  if (p < 10000)   return 'до 10000 руб до десяти тысяч средний бюджет';
  if (p < 20000)   return 'до 20000 руб до двадцати тысяч средний';
  if (p < 30000)   return 'до 30000 руб до тридцати тысяч средний бюджет';
  if (p < 50000)   return 'до 50000 руб до пятидесяти тысяч';
  if (p < 80000)   return 'до 80000 руб до восьмидесяти тысяч премиум';
  if (p < 100000)  return 'до 100000 руб до ста тысяч премиум флагман';
  return 'от 100000 руб премиум топовый флагман дорогой';
}

function enrichDescription(offer) {
  const name = String(offer['name'] ?? '').trim();
  let desc = String(offer['description'] ?? '').trim();

  // Удаляем дублирующийся блок (фид Kstore содержит content × 2 — раздувает chunks).
  const firstSentence = desc.split(/[.!?\n]/)[0];
  if (firstSentence && firstSentence.length > 20) {
    const secondOccurrence = desc.indexOf(firstSentence, firstSentence.length);
    if (secondOccurrence > 0) {
      desc = desc.slice(0, secondOccurrence).trim().replace(/[.,;]\s*$/, '');
    }
  }

  const additions = [];
  for (const pat of NAME_PATTERNS) {
    if (pat.re.test(name)) additions.push(pat.add);
  }

  const vendor = String(offer['vendor'] ?? '').toLowerCase().trim();
  if (vendor && BRAND_SYNONYMS[vendor]) {
    additions.push(BRAND_SYNONYMS[vendor]);
  }

  const priceRaw = parseInt(String(offer['price'] ?? '0').replace(/[^\d]/g, ''), 10);
  const zone = priceZoneSyn(priceRaw);
  if (zone) additions.push(zone);

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

  desc = desc.replace(/По вопросам заказа звоните:\s*8\s*\(800\)\s*551-?26-?10\s*!?/gi, '').trim();

  for (const add of additions) {
    desc = appendUnique(desc, add);
  }

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

const offers = feed?.yml_catalog?.shop?.offers?.offer ?? [];

let touched = 0;
let totalLen = 0;
let overlong = 0;
for (const offer of offers) {
  const before = offer['description'];
  const after = enrichDescription(offer);
  if (after !== before) {
    offer['description'] = after;
    touched++;
  }
  totalLen += String(after ?? '').length;
  if (String(after ?? '').length >= 850) overlong++;
}

mkdirSync('public', { recursive: true });
writeFileSync(OUT_PATH, builder.build(feed), 'utf-8');

console.log(
  `Done. Offers total: ${offers.length}, enriched: ${touched}, ` +
  `avg description: ${Math.round(totalLen / Math.max(offers.length, 1))} chars, ` +
  `at-cap (≥850): ${overlong}. Written to ${OUT_PATH}`
);
