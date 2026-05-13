# Kstore proxy-feed

Прокси-фид для AI-консультанта Kstore на платформе B24U.

Источник: `https://kstore.ru/bitrix/catalog_export/export_0fM.xml` (Bitrix-выгрузка YML).
Назначение: отобрать 100 товаров (лимит тарифа B24U) из ~2500 ассортимента по 17 категориям × разный ценовой сегмент, дописать в `<description>` разговорные синонимы для лучшего матчинга RAG-поиска.

Подключённый URL: `https://stepanenkoviktor0110-boop.github.io/kstore-proxy-feed/feed.xml`

Подробнее — `clients/kstore/proxy-feed/README.md` в основном репо b24u-playbook.

## Локальная сборка

```bash
npm install
node build-feed.mjs
```
