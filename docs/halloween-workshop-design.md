# 月夜のかぼちゃ工房

2026-10-20。文化祭の制作画面を「もう少しハロウィンぽく」、複数の事例を検索したうえで更新する依頼。

## 調べた事例と採用した考え方

- [InstaGourd](https://instagourd.com/)：デジタルのジャックオランタンを、月夜や霧などの背景に置く。背景が体験の雰囲気を作る考え方を参考にした。
- [Disney Parks Blog の Halloween Party](https://disneyparksblog.com/wdw/plan-your-mickeys-not-so-scary-halloween-party-visit/)：衣装、トリック・オア・トリート、特別な照明を組み合わせたお祭り。文化祭向けに、怖がらせるより楽しく参加できる温度感を参考にした。
- [Desk Job Design Lab の Pumpkin Carving](https://www.deskjob.org/workshops/pumpkin-carving)：下描き、彫る、整える、完成という制作の流れ。道具と作業手順が伝わる画面づくりを参考にした。
- [Lessonspace の Virtual Pumpkin Carving](https://www.thelessonspace.com/templates/virtual-pumpkin-carving)：自由な線や形で自分のかぼちゃを作り、共有する授業用の活動。自分の模様を作る機能を中心に残した。

これは各サービスの機能や雰囲気から得たデザイン上の解釈であり、第三者の画面・画像・ロゴを複製していない。

## 実装

夜紺・深紫の作業面、かぼちゃ色の灯り、淡い月と端のコウモリ、低い柵と秋の葉。すべて独自の静止した描画で、中央のかぼちゃ表面には装飾を重ねない。背景はキャッシュし、描画負荷を抑える。カメラ使用中は半透明にして手の映像を保つ。

4種類の彫り方に道具の絵と短い説明を付ける。選択中は明るいかぼちゃ色。スマホでは2列、タッチ領域は44px以上。展示と投げるボタン、保存、戻す・やり直す、形と太さの設定は維持する。

適用範囲は公開体験画面の `carving` モード。投球の判定・彫刻データ・カメラ認識・展示への送信形式を変えない。追加の外部フォント・画像・通信・音はない。
