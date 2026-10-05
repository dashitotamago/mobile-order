/* 3つのページ(order / kitchen / qr)共通の設定です。ここだけ書き換えてください。 */
window.MO_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycby8uuOzZ9DXVgVS9FUYrfSKl1EOmmgtyxmvklUs7zp2-Ix_oSYxEBsqfT3S1t60r2h4HA/exec',
                        // GASのウェブアプリURL(https://script.google.com/macros/s/…/exec)。空のままだとデモ表示になります
  SHOP_NAME: 'お店の名前',   // 画面上部とQRカードに表示する店名
  ALLOW_NOTE: false,        // true にすると、お客様が商品ごとにメモ(例:氷なし)を書けます
  POLL_MS: 5000,            // 厨房画面の更新間隔(ミリ秒)
  WARN_MIN: 10,             // 注文からこの分数を過ぎると経過時間が黄色に
  LATE_MIN: 20              // この分数を過ぎると赤に
};
