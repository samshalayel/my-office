# مشروع: المكتب الافتراضي التفاعلي

## الستاك
- HTML + CSS + JavaScript فقط (ES Modules). لا bundler، لا npm، لا build، لا مكتبات غير Three.js.
- Three.js r170 من CDN عبر import map:
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
- التشغيل على السيرفر: `python3 -m http.server 8080 --bind 0.0.0.0` من مجلد المشروع، ثم http://<عنوان-السيرفر>:8080 (أو http://localhost:8080 من داخل السيرفر).
- المشروع مستودع git على GitHub؛ كل مرحلة ناجحة تُحفظ بـ commit باسم المرحلة.

## هيكل الملفات (لا تُنشئ ملفات خارج هذا الهيكل)
index.html          الواجهة + import map
css/style.css       كل الأنماط
js/main.js          renderer, camera, controls, render loop, input
js/materials.js     كائن mats + كائن neon + مساعدات الهندسة (box/cyl/sphere/plane/mesh) + مولّدات الملمس
js/room.js          الغرفة: أرضية، جدران، سقف، نافذة، إضاءة
js/furniture.js     الأثاث
js/gallery.js       اللوحات على الجدران
js/branding.js      لافتة النيون
js/cv.js            Transform Mode + عرض السيرة الذاتية
js/panel.js         لوحة التحكم + الحفظ في localStorage
js/tween.js         محرك حركة بسيط
js/data.js          المحتوى الافتراضي (البراند + السيرة)

## الأبعاد والكاميرا
- الوحدات بالمتر. الغرفة: عرض 10 (x) × عمق 8 (z) × ارتفاع 3.2 (y). الأرضية عند y=0، مركز الغرفة (0,0,0).
- الجدار الخلفي عند z=-4 (جدار السلات)، الجدار الأمامي عند z=+4، الأيمن x=+5، الأيسر x=-5.
- الكاميرا الافتراضية: PerspectiveCamera(50°) عند (0, 1.75, 4.6) تنظر إلى (0, 1.0, -1.4). near 0.1، far 140.

## المواد — كائن `mats` في materials.js (استخدم هذه القيم حرفيًا؛ MeshStandardMaterial ما لم يُذكر غير ذلك)
| الاسم          | color   | roughness | metalness | ملاحظات |
|----------------|---------|-----------|-----------|---------|
| wall           | #23262e | 0.92 | 0    | |
| wallDark       | #14161b | 0.90 | 0    | الجدار الخلفي |
| ceiling        | #1b1d23 | 0.95 | 0    | |
| trim           | #0c0d10 | 0.50 | 0.40 | إطارات وكورنيش |
| walnut         | #3b2418 | 0.35 | 0.05 | خشب الجوز: السلات، المكتب |
| deskTop        | #0f1013 | 0.18 | 0.25 | سطح المكتب الزجاجي الداكن |
| blackMetal     | #111214 | 0.35 | 0.80 | |
| chrome         | #d8dbe0 | 0.15 | 1.00 | |
| leather        | #15161a | 0.55 | 0.05 | |
| leatherStitch  | #2a2c33 | 0.70 | 0    | |
| fabric         | #2b3340 | 0.95 | 0    | كراسي الضيوف |
| frame          | #0a0a0c | 0.30 | 0.60 | إطار النافذة واللوحات |
| glass          | #9ec9ff | 0.05 | 0    | MeshPhysicalMaterial، transparent، opacity 0.18، depthWrite:false |
| screen         | #05070a | 0.20 | 0.10 | emissive #0e2a3a، emissiveIntensity 1.2 |
| plant          | #2f7a3a | 0.90 | 0    | |
| pot            | #2a2d35 | 0.60 | 0.20 | |
- كائن `neon` (MeshBasicMaterial، toneMapped:false — غير مضاء عمدًا): primary #00e5ff، accent #ff2bd6، warm #ffc98a.
- قاعدة صارمة: كل Mesh يأخذ مادة من `mats` أو `neon`. ممنوع ترك المادة الافتراضية البيضاء، وممنوع إنشاء مادة داخل حلقة.
- الهندسة المتكررة تُخزَّن في cache بمفتاح الأبعاد (دوال box/cyl/sphere/plane في materials.js). الحواف المدوّرة عبر RoundedBoxGeometry من addons.

## الإضاءة والرندر — قيم ثابتة (Three.js r170 يستخدم وحدات فيزيائية: لا تضاعف الشدّات ولا تضف AmbientLight)
- renderer: antialias، outputColorSpace = SRGBColorSpace، toneMapping = ACESFilmicToneMapping، toneMappingExposure = 1.05، shadowMap PCFSoftShadowMap، pixelRatio ≤ 1.5.
- scene.background = #05060a. scene.environment = RoomEnvironment عبر PMREMGenerator، environmentIntensity 0.45.
- HemisphereLight(#8fb2ff, #1a1020, 0.4).
- DirectionalLight(#fff1e0, 1.6) عند (2.5, 3.0, 2.5) هدفه (0, 0.6, -1.5)، castShadow، mapSize 1024، bias -0.0008، normalBias 0.02، frustum ±5/±4، near 0.5، far 12.
- PointLight للنيون: شدة 3.5، مدى 5، decay 2. PointLight مصباح المكتب: #ffd7a8، شدة 1.8، مدى 2.2. PointLight تحت المكتب: #00e5ff، شدة 2.5، مدى 3.
- سقف الشدة لأي ضوء: 5. سقف الأضواء النقطية: 6.
- الرندر عند الطلب: ارسم إطارًا فقط عند تغيّر الكاميرا أو وجود حركة (tween) أو تغيير محتوى.

## طريقة العمل
- نفّذ التعليمة الحالية فقط. لا تعدّل ملفًا خارج نطاقها إلا للضرورة، واذكر ذلك في تقريرك.
- بعد كل تعديل تأكد أن الصفحة تعمل بدون أخطاء في الكونسول قبل أن تعلن الانتهاء.
- اختم كل مهمة بتقرير قصير: ما أُنجز، ما لم يُنجز ولماذا، وما الذي يجب أن يراه الإنسان على الشاشة.
