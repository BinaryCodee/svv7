// ══════════════════════════════════════════════════════════════════
//  StreamVault — all.js  v7.0
//  Performance: API cache, request deduplication, lazy images,
//  debounce, virtual rendering, memory management, 100k traffic
// ══════════════════════════════════════════════════════════════════
'use strict';

const TMDB_KEY  = "9c514e5ccf41247cdf22b26dd5b33a98";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG  = "https://image.tmdb.org/t/p/";

// ── PERFORMANCE: API Response Cache (TTL 5min) ─────────────────────
const _apiCache   = new Map(); // key → {data, ts}
const _inFlight   = new Map(); // key → Promise (deduplication)
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes
const IMG_SIZES   = {poster:"w342",backdrop:"w1280",posterSm:"w185"};

// ── STATE ─────────────────────────────────────────────────────────
let currentLang  = "it";
let userRegion   = "IT";
let currentPage  = "home";
let heroPool     = [];
let heroIdx      = 0;
let heroTimer    = null;
let moviesBrowsePage  = 1;
let moviesBrowseGenre = "";
let showsBrowsePage   = 1;
let showsBrowseGenre  = "";
let wishlist     = [];
let searchTimer  = null;
let toastTimer   = null;
// Modal
let _mId=null,_mType=null,_mSeason=1,_mEpisode=1;
let _mEpCounts={},_mTotalSeasons=1,_currentSource=0;
// Quality: "auto" | "1080p"
let _currentQuality="auto";
// User rank/permissions (read from server-injected JSON)
const _SV_USER=(()=>{try{const e=document.getElementById("_svUser");return e?JSON.parse(e.textContent||"{}"):{};}catch(_){return {};}})();
const _CAN_1080P = _SV_USER.is_admin || ["Medium","Premium"].includes(_SV_USER.rank);
// IntersectionObserver for lazy images
let _imgObserver = null;
// Scroll listener debounce
let _scrollRaf   = null;

// ── EMBED SOURCES ─────────────────────────────────────────────────
// ISO 639-1 codes for subtitle/dub language selection per embed system.
const LANG_CODES = {
  it:{uembed:"it",vidsrc:"it",smash:"it"},
  en:{uembed:"en",vidsrc:"en",smash:"en"},
  es:{uembed:"es",vidsrc:"es",smash:"es"},
  fr:{uembed:"fr",vidsrc:"fr",smash:"fr"},
  de:{uembed:"de",vidsrc:"de",smash:"de"},
  pt:{uembed:"pt",vidsrc:"pt",smash:"pt"},
  ja:{uembed:"ja",vidsrc:"ja",smash:"ja"},
  zh:{uembed:"zh",vidsrc:"zh",smash:"zh"},
  ko:{uembed:"ko",vidsrc:"ko",smash:"ko"},
  ru:{uembed:"ru",vidsrc:"ru",smash:"ru"},
  ar:{uembed:"ar",vidsrc:"ar",smash:"ar"},
  hi:{uembed:"hi",vidsrc:"hi",smash:"hi"},
  nl:{uembed:"nl",vidsrc:"nl",smash:"nl"},
  pl:{uembed:"pl",vidsrc:"pl",smash:"pl"},
  tr:{uembed:"tr",vidsrc:"tr",smash:"tr"},
};
function gl(k){ return (LANG_CODES[currentLang]&&LANG_CODES[currentLang][k]) || LANG_CODES.en[k] }

// ── VidSrc-embed API (4 mirror domains, ds_lang for subtitle default) ──
function vsUrl(domain,{id,type,season,episode}){
  const l=gl("vidsrc");
  if(type==="tv") return `https://${domain}/embed/tv?tmdb=${id}&season=${season}&episode=${episode}&ds_lang=${l}&autonext=1&autoplay=1`;
  return `https://${domain}/embed/movie?tmdb=${id}&ds_lang=${l}&autoplay=1`;
}

// ── Videasy — color matches StreamVault purple, nextEpisode+autoplay+episodeSelector ──
function videasyUrl({id,type,season,episode}){
  const color="6246EA"; // StreamVault brand purple (no #)
  if(type==="tv") return `https://player.videasy.net/tv/${id}/${season}/${episode}?color=${color}&nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true`;
  return `https://player.videasy.net/movie/${id}?color=${color}&overlay=true`;
}

// ── StreamMafia — server=lang for audio track selection ──
// server param: "italian", "english", "french", "german", "spanish", "portuguese", "hindi" etc.
const SM_SERVER_MAP={it:"italian",en:"english",fr:"french",de:"german",es:"spanish",pt:"portuguese",hi:"hindi",ja:"japanese",zh:"chinese",ko:"korean",ru:"russian",ar:"arabic"};
function smafiaUrl({id,type,season,episode}){
  const srv=SM_SERVER_MAP[currentLang]||"english";
  // StreamMafia API: https://embed.streammafia.to/embed/movie/{tmdbId}
  //                  https://embed.streammafia.to/embed/tv/{tmdbId}/{season}/{episode}
  if(type==="tv") return `https://embed.streammafia.to/embed/tv/${id}/${season}/${episode}?server=${srv}&servericon=false`;
  return `https://embed.streammafia.to/embed/movie/${id}?server=${srv}&servericon=false`;
}

// ─────────────────────────────────────────────────────────────────
// SOURCES — vixsrc.to only
// ─────────────────────────────────────────────────────────────────
const SOURCES=[
  {label:"VixSrc",short:"VIX",langSupport:true,
   build({id,type,season,episode}){
     const l=currentLang||"it";
     const q=_currentQuality==="1080p"?"&quality=1080p":"";
     if(type==="tv") return `https://vixsrc.to/tv/${id}/${season}/${episode}?autoplay=true&lang=${l}${q}`;
     return `https://vixsrc.to/movie/${id}?autoplay=true&lang=${l}${q}`;
   }},
];

// ─────────────────────────────────────────────────────────────────
// SMART LANGUAGE PROBE SYSTEM
// When user opens a title, we:
// 1. Check if language is "en" — skip probing, just load first source
// 2. For non-EN: cycle through sources with langSupport:true in background
// 3. Load the iframe hidden, listen for postMessage or timeout (3s)
// 4. If a source loads successfully with content → auto-start it
// 5. If no native dub found → show "subtitle only" notice, still play
// ─────────────────────────────────────────────────────────────────
let _probeActive=false;
let _probeAbort=null;

// Languages that almost always have native dub (skip slow probe)
const LANGS_WITH_DUB=new Set(["en","it","es","fr","de","pt","hi","ja","zh","ko","ru","ar"]);

// Per-language best source index cache (sessionStorage key: sv_src_{lang})
function _getBestSourceIdx(){
  try{ return parseInt(sessionStorage.getItem(`sv_src_${currentLang}`)||"0")||0 }catch{ return 0 }
}
function _setBestSourceIdx(idx){
  try{ sessionStorage.setItem(`sv_src_${currentLang}`,String(idx)) }catch{}
}

// ── I18N ──────────────────────────────────────────────────────────
const LANGS={
  it:{tab_movies:"Film",tab_shows:"Serie",hero_badge:"In Evidenza",watch_now:"Guarda ora",more_info:"Più info",trending:"🔥 Di Tendenza",popular_movies:"🎬 Film Popolari",popular_shows:"📺 Serie Popolari",load_more:"Carica altro",search_placeholder:"Cerca film e serie…",no_results:"Nessun risultato.",genre_all:"Tutti",tab_wishlist:"Wishlist",wl_clear:"Svuota tutto",wl_empty_title:"La tua lista è vuota",wl_empty_sub:"Tocca ♡ su qualsiasi titolo per salvarlo.",see_all:"Vedi tutti",added_wl:"Aggiunto",removed_wl:"Rimosso",maint_title:"Manutenzione",maint_sub:"Aggiornamento in corso.",nav_home:"Home",nav_trending:"Tendenze",nav_login:"Accedi",nav_register:"Registrati",nav_tos:"Termini",coming_soon:"Prossimamente",coming_soon_login:"Login in arrivo!",coming_soon_reg:"Registrazione in arrivo!"},
  en:{tab_movies:"Movies",tab_shows:"Series",hero_badge:"Featured Today",watch_now:"Watch Now",more_info:"More Info",trending:"🔥 Trending",popular_movies:"🎬 Popular Movies",popular_shows:"📺 Popular Series",load_more:"Load More",search_placeholder:"Search movies & series…",no_results:"No results.",genre_all:"All",tab_wishlist:"Wishlist",wl_clear:"Clear All",wl_empty_title:"Your wishlist is empty",wl_empty_sub:"Tap ♡ on any title to save it here.",see_all:"See all",added_wl:"Added",removed_wl:"Removed",maint_title:"Maintenance",maint_sub:"We're updating.",nav_home:"Home",nav_trending:"Trending",nav_login:"Log In",nav_register:"Sign Up",nav_tos:"Terms",coming_soon:"Coming Soon",coming_soon_login:"Login on the way!",coming_soon_reg:"Registration almost ready!"},
  es:{tab_movies:"Películas",tab_shows:"Series",hero_badge:"Destacado",watch_now:"Ver Ahora",more_info:"Más Info",trending:"🔥 Tendencias",popular_movies:"🎬 Populares",popular_shows:"📺 Series Populares",load_more:"Cargar Más",search_placeholder:"Buscar…",no_results:"Sin resultados.",genre_all:"Todos",tab_wishlist:"Lista",wl_clear:"Limpiar",wl_empty_title:"Lista vacía",wl_empty_sub:"Toca ♡ para guardar.",see_all:"Ver todos",added_wl:"Añadido",removed_wl:"Eliminado",maint_title:"Mantenimiento",maint_sub:"Actualizando.",nav_home:"Inicio",nav_trending:"Tendencias",nav_login:"Entrar",nav_register:"Registrarse",nav_tos:"Términos",coming_soon:"Próximamente",coming_soon_login:"Login pronto!",coming_soon_reg:"Registro pronto!"},
  fr:{tab_movies:"Films",tab_shows:"Séries",hero_badge:"En Vedette",watch_now:"Regarder",more_info:"Plus d'Info",trending:"🔥 Tendances",popular_movies:"🎬 Populaires",popular_shows:"📺 Séries Populaires",load_more:"Charger Plus",search_placeholder:"Rechercher…",no_results:"Aucun résultat.",genre_all:"Tous",tab_wishlist:"Ma Liste",wl_clear:"Effacer",wl_empty_title:"Liste vide",wl_empty_sub:"Appuyez ♡ pour sauvegarder.",see_all:"Voir tout",added_wl:"Ajouté",removed_wl:"Retiré",maint_title:"Maintenance",maint_sub:"Mise à jour.",nav_home:"Accueil",nav_trending:"Tendances",nav_login:"Connexion",nav_register:"S'inscrire",nav_tos:"Conditions",coming_soon:"Bientôt",coming_soon_login:"Connexion bientôt!",coming_soon_reg:"Inscription bientôt!"},
  de:{tab_movies:"Filme",tab_shows:"Serien",hero_badge:"Empfohlen",watch_now:"Ansehen",more_info:"Mehr Info",trending:"🔥 Trending",popular_movies:"🎬 Beliebt",popular_shows:"📺 Beliebte Serien",load_more:"Mehr Laden",search_placeholder:"Suchen…",no_results:"Keine Ergebnisse.",genre_all:"Alle",tab_wishlist:"Merkliste",wl_clear:"Löschen",wl_empty_title:"Merkliste leer",wl_empty_sub:"♡ antippen zum Speichern.",see_all:"Alle sehen",added_wl:"Hinzugefügt",removed_wl:"Entfernt",maint_title:"Wartung",maint_sub:"Aktualisierung.",nav_home:"Startseite",nav_trending:"Trending",nav_login:"Anmelden",nav_register:"Registrieren",nav_tos:"AGB",coming_soon:"Demnächst",coming_soon_login:"Login bald!",coming_soon_reg:"Registrierung bald!"},
  pt:{tab_movies:"Filmes",tab_shows:"Séries",hero_badge:"Destaque",watch_now:"Assistir",more_info:"Mais Info",trending:"🔥 Em Alta",popular_movies:"🎬 Populares",popular_shows:"📺 Séries Populares",load_more:"Carregar Mais",search_placeholder:"Buscar…",no_results:"Sem resultados.",genre_all:"Todos",tab_wishlist:"Lista",wl_clear:"Limpar",wl_empty_title:"Lista vazia",wl_empty_sub:"Toque ♡ para salvar.",see_all:"Ver tudo",added_wl:"Adicionado",removed_wl:"Removido",maint_title:"Manutenção",maint_sub:"Atualizando.",nav_home:"Início",nav_trending:"Em Alta",nav_login:"Entrar",nav_register:"Registrar",nav_tos:"Termos",coming_soon:"Em breve",coming_soon_login:"Login em breve!",coming_soon_reg:"Registro em breve!"},
  ja:{tab_movies:"映画",tab_shows:"シリーズ",hero_badge:"注目",watch_now:"今すぐ見る",more_info:"詳細",trending:"🔥 トレンド",popular_movies:"🎬 人気映画",popular_shows:"📺 人気シリーズ",load_more:"もっと見る",search_placeholder:"検索…",no_results:"結果なし。",genre_all:"すべて",tab_wishlist:"リスト",wl_clear:"全削除",wl_empty_title:"リスト空",wl_empty_sub:"♡タップで保存。",see_all:"すべて見る",added_wl:"追加",removed_wl:"削除",maint_title:"メンテナンス",maint_sub:"更新中。",nav_home:"ホーム",nav_trending:"トレンド",nav_login:"ログイン",nav_register:"登録",nav_tos:"規約",coming_soon:"近日",coming_soon_login:"近日!",coming_soon_reg:"近日!"},
  zh:{tab_movies:"电影",tab_shows:"剧集",hero_badge:"今日精选",watch_now:"立即观看",more_info:"详情",trending:"🔥 热门",popular_movies:"🎬 热门电影",popular_shows:"📺 热门剧集",load_more:"加载更多",search_placeholder:"搜索…",no_results:"无结果。",genre_all:"全部",tab_wishlist:"收藏",wl_clear:"清空",wl_empty_title:"收藏夹空",wl_empty_sub:"点击♡保存。",see_all:"全部",added_wl:"已加",removed_wl:"已删",maint_title:"维护",maint_sub:"更新中。",nav_home:"首页",nav_trending:"热门",nav_login:"登录",nav_register:"注册",nav_tos:"条款",coming_soon:"即将",coming_soon_login:"即将!",coming_soon_reg:"即将!"},
  ko:{tab_movies:"영화",tab_shows:"시리즈",hero_badge:"오늘의 추천",watch_now:"지금 보기",more_info:"자세히",trending:"🔥 트렌딩",popular_movies:"🎬 인기 영화",popular_shows:"📺 인기 시리즈",load_more:"더 보기",search_placeholder:"검색…",no_results:"결과 없음.",genre_all:"전체",tab_wishlist:"찜 목록",wl_clear:"모두 삭제",wl_empty_title:"목록이 비어있습니다",wl_empty_sub:"♡를 눌러 저장하세요.",see_all:"모두 보기",added_wl:"추가됨",removed_wl:"삭제됨",maint_title:"점검 중",maint_sub:"업데이트 중.",nav_home:"홈",nav_trending:"트렌딩",nav_login:"로그인",nav_register:"회원가입",nav_tos:"이용약관",coming_soon:"출시 예정",coming_soon_login:"로그인 출시 예정!",coming_soon_reg:"회원가입 출시 예정!"},
  ru:{tab_movies:"Фильмы",tab_shows:"Сериалы",hero_badge:"Рекомендуем",watch_now:"Смотреть",more_info:"Подробнее",trending:"🔥 Тренды",popular_movies:"🎬 Популярные",popular_shows:"📺 Популярные сериалы",load_more:"Загрузить ещё",search_placeholder:"Поиск…",no_results:"Нет результатов.",genre_all:"Все",tab_wishlist:"Список",wl_clear:"Очистить",wl_empty_title:"Список пуст",wl_empty_sub:"Нажмите ♡ для сохранения.",see_all:"Все",added_wl:"Добавлено",removed_wl:"Удалено",maint_title:"Обслуживание",maint_sub:"Обновление.",nav_home:"Главная",nav_trending:"Тренды",nav_login:"Войти",nav_register:"Регистрация",nav_tos:"Условия",coming_soon:"Скоро",coming_soon_login:"Скоро!",coming_soon_reg:"Скоро!"},
  ar:{tab_movies:"أفلام",tab_shows:"مسلسلات",hero_badge:"مميز اليوم",watch_now:"شاهد الآن",more_info:"المزيد",trending:"🔥 الأكثر رواجاً",popular_movies:"🎬 أفلام شعبية",popular_shows:"📺 مسلسلات شعبية",load_more:"تحميل المزيد",search_placeholder:"بحث…",no_results:"لا نتائج.",genre_all:"الكل",tab_wishlist:"قائمتي",wl_clear:"مسح الكل",wl_empty_title:"القائمة فارغة",wl_empty_sub:"اضغط ♡ للحفظ.",see_all:"الكل",added_wl:"تمت الإضافة",removed_wl:"تمت الإزالة",maint_title:"صيانة",maint_sub:"جاري التحديث.",nav_home:"الرئيسية",nav_trending:"الأكثر رواجاً",nav_login:"تسجيل الدخول",nav_register:"إنشاء حساب",nav_tos:"الشروط",coming_soon:"قريباً",coming_soon_login:"قريباً!",coming_soon_reg:"قريباً!"},
  hi:{tab_movies:"फ़िल्में",tab_shows:"सीरीज़",hero_badge:"आज की सिफारिश",watch_now:"अभी देखें",more_info:"और जानें",trending:"🔥 ट्रेंडिंग",popular_movies:"🎬 लोकप्रिय फ़िल्में",popular_shows:"📺 लोकप्रिय सीरीज़",load_more:"और लोड करें",search_placeholder:"खोजें…",no_results:"कोई परिणाम नहीं.",genre_all:"सभी",tab_wishlist:"विशलिस्ट",wl_clear:"सब हटाएं",wl_empty_title:"विशलिस्ट खाली है",wl_empty_sub:"सेव करने के लिए ♡ दबाएं.",see_all:"सभी देखें",added_wl:"जोड़ा गया",removed_wl:"हटाया गया",maint_title:"मेंटेनेंस",maint_sub:"अपडेट हो रहा है.",nav_home:"होम",nav_trending:"ट्रेंडिंग",nav_login:"लॉगिन",nav_register:"साइन अप",nav_tos:"नियम",coming_soon:"जल्द आ रहा है",coming_soon_login:"जल्द!",coming_soon_reg:"जल्द!"},
};

// ── Full country → language map (ISO 3166-1 alpha-2 → ISO 639-1) ──
const COUNTRY_LANG={
  // Italian
  IT:"it",
  // Spanish
  ES:"es",MX:"es",AR:"es",CO:"es",CL:"es",PE:"es",VE:"es",EC:"es",
  BO:"es",PY:"es",UY:"es",CR:"es",PA:"es",DO:"es",GT:"es",HN:"es",SV:"es",NI:"es",CU:"es",
  // French
  FR:"fr",BE:"fr",CH:"fr",LU:"fr",MC:"fr",SN:"fr",CI:"fr",CM:"fr",MG:"fr",
  BF:"fr",ML:"fr",NE:"fr",TG:"fr",BJ:"fr",GN:"fr",CD:"fr",CG:"fr",GA:"fr",
  // German
  DE:"de",AT:"de",LI:"de",
  // Portuguese
  BR:"pt",PT:"pt",AO:"pt",MZ:"pt",CV:"pt",GW:"pt",ST:"pt",TL:"pt",
  // Japanese
  JP:"ja",
  // Chinese
  CN:"zh",TW:"zh",HK:"zh",SG:"zh",MO:"zh",
  // Korean
  KR:"ko",
  // Russian
  RU:"ru",UA:"ru",BY:"ru",KZ:"ru",
  // Arabic
  SA:"ar",AE:"ar",EG:"ar",IQ:"ar",SY:"ar",JO:"ar",LB:"ar",LY:"ar",
  TN:"ar",DZ:"ar",MA:"ar",SD:"ar",YE:"ar",OM:"ar",KW:"ar",BH:"ar",QA:"ar",
  // Hindi
  IN:"hi",
  // Dutch
  NL:"nl",
  // Polish
  PL:"pl",
  // Turkish
  TR:"tr",
  // English (default for anything else)
  US:"en",GB:"en",CA:"en",AU:"en",NZ:"en",IE:"en",ZA:"en",
  NG:"en",GH:"en",KE:"en",PK:"en",
};
const LANG_FLAGS={it:"🇮🇹",en:"🇺🇸",es:"🇪🇸",fr:"🇫🇷",de:"🇩🇪",pt:"🇧🇷",ja:"🇯🇵",zh:"🇨🇳",ko:"🇰🇷",ru:"🇷🇺",ar:"🇸🇦",hi:"🇮🇳",nl:"🇳🇱",pl:"🇵🇱",tr:"🇹🇷"};
const LANG_CODES_UC={it:"IT",en:"EN",es:"ES",fr:"FR",de:"DE",pt:"PT",ja:"JA",zh:"ZH",ko:"KO",ru:"RU",ar:"AR",hi:"HI",nl:"NL",pl:"PL",tr:"TR"};
const LANG_NAMES_FULL={it:"Italiano",en:"English",es:"Español",fr:"Français",de:"Deutsch",pt:"Português",ja:"日本語",zh:"中文",ko:"한국어",ru:"Русский",ar:"العربية",hi:"हिन्दी",nl:"Nederlands",pl:"Polski",tr:"Türkçe"};
const TMDB_LANG_MAP ={zh:"zh-CN",ja:"ja-JP",pt:"pt-BR",de:"de-DE",fr:"fr-FR",es:"es-ES",it:"it-IT"};

const MOVIE_GENRES=[{id:"",key:"genre_all"},{id:"28",label:"Action"},{id:"12",label:"Adventure"},{id:"16",label:"Animation"},{id:"35",label:"Comedy"},{id:"80",label:"Crime"},{id:"99",label:"Documentary"},{id:"18",label:"Drama"},{id:"14",label:"Fantasy"},{id:"27",label:"Horror"},{id:"10749",label:"Romance"},{id:"878",label:"Sci-Fi"},{id:"53",label:"Thriller"}];
const TV_GENRES   =[{id:"",key:"genre_all"},{id:"10759",label:"Action & Adventure"},{id:"16",label:"Animation"},{id:"35",label:"Comedy"},{id:"80",label:"Crime"},{id:"99",label:"Documentary"},{id:"18",label:"Drama"},{id:"10765",label:"Sci-Fi & Fantasy"},{id:"9648",label:"Mystery"},{id:"10751",label:"Family"}];

// ── UTILS ─────────────────────────────────────────────────────────
function t(k){return(LANGS[currentLang]&&LANGS[currentLang][k])||LANGS.en[k]||k}
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function posterUrl(p,sz="w342"){return p?`${TMDB_IMG}${sz}${p}`:"https://placehold.co/342x513/100d20/6246EA?text=?"}
function backdropUrl(p,sz="w1280"){return p?`${TMDB_IMG}${sz}${p}`:""}
function tmdbLang(){return TMDB_LANG_MAP[currentLang]||"en-US"}

// ── PERFORMANCE: Cached TMDB fetch with deduplication ────────────
async function tmdb(endpoint,params={}){
  const url=new URL(TMDB_BASE+endpoint);
  url.searchParams.set("api_key",TMDB_KEY);
  url.searchParams.set("language",tmdbLang());
  for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  const key=url.toString();

  // Return cached if fresh
  const cached=_apiCache.get(key);
  if(cached&&Date.now()-cached.ts<CACHE_TTL) return cached.data;

  // Deduplicate in-flight requests
  if(_inFlight.has(key)) return _inFlight.get(key);

  const promise=(async()=>{
    try{
      const r=await fetch(key,{
        headers:{"Accept":"application/json"},
        // Cache-Control hint for CDN/browser
        cache:"default"
      });
      if(!r.ok) return null;
      const data=await r.json();
      _apiCache.set(key,{data,ts:Date.now()});
      // Evict old cache entries if too large (memory management)
      if(_apiCache.size>200){
        const oldest=_apiCache.keys().next().value;
        _apiCache.delete(oldest);
      }
      return data;
    }catch(e){console.warn("TMDB:",e.message);return null}
    finally{_inFlight.delete(key)}
  })();

  _inFlight.set(key,promise);
  return promise;
}

// ── PERFORMANCE: Lazy image loading via IntersectionObserver ─────
function initImgObserver(){
  if(!('IntersectionObserver' in window)){
    // Fallback: load all images immediately
    _imgObserver={observe:el=>{el.src=el.dataset.src||el.src}};
    return;
  }
  _imgObserver=new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        const img=entry.target;
        if(img.dataset.src){
          img.src=img.dataset.src;
          img.removeAttribute("data-src");
        }
        _imgObserver.unobserve(img);
      }
    });
  },{rootMargin:"200px 0px",threshold:0});
}

function lazyImg(src,alt,cls,onerr){
  // Use data-src for lazy loading, placeholder as src
  const ph="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 3'%3E%3C/svg%3E";
  return `<img class="${cls}" src="${ph}" data-src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="${onerr||''}" >`;
}

// ── TRANSLATIONS ──────────────────────────────────────────────────
function applyTranslations(){
  document.querySelectorAll("[data-i18n]").forEach(el=>el.textContent=t(el.dataset.i18n));
  document.documentElement.lang=currentLang;
  const si=document.getElementById("search-input");
  if(si) si.placeholder=t("search_placeholder");
  document.querySelectorAll(".sidebar-lang-btn").forEach(b=>b.classList.toggle("active",b.dataset.lang===currentLang));
  updateTopbarLang();
  updateTopbarTitle();
}
function updateTopbarLang(){
  const f=document.getElementById("topbar-lang-flag");
  const c=document.getElementById("topbar-lang-code");
  if(f) f.textContent=LANG_FLAGS[currentLang]||"🌐";
  if(c) c.textContent=LANG_CODES_UC[currentLang]||currentLang.toUpperCase();
}
const PAGE_TITLE_KEYS={home:null,movies:"tab_movies",shows:"tab_shows",trending:"nav_trending",wishlist:"tab_wishlist",tos:null,privacy:null,dmca:null};
const PAGE_TITLE_FIXED={home:"StreamVault",tos:"Terms",privacy:"Privacy",dmca:"DMCA"};
function updateTopbarTitle(){
  const el=document.getElementById("topbar-title");
  if(!el) return;
  el.textContent=PAGE_TITLE_FIXED[currentPage]||(PAGE_TITLE_KEYS[currentPage]?t(PAGE_TITLE_KEYS[currentPage]):"StreamVault");
}

function setLanguage(lang){
  if(!LANGS[lang]) return;
  currentLang=lang;
  localStorage.setItem("sv_lang",lang);
  // Invalidate cache so content reloads in new language
  _apiCache.clear();
  applyTranslations();
  loadHomeMovies();
  loadHomeShows();
  loadHero();
  showToast(`${LANG_FLAGS[lang]||""} ${LANG_CODES_UC[lang]||lang}`,"info");
}

async function detectLanguage(){
  try{
    // 1. Saved preference always wins — no overwrite
    const saved=localStorage.getItem("sv_lang");
    if(saved){
      currentLang=saved;
      applyTranslations();
      return;
    }

    // 2. Try browser language first (instant, no network)
    const browserLang=(navigator.language||navigator.userLanguage||"").slice(0,2).toLowerCase();
    if(browserLang && LANGS[browserLang]){
      currentLang=browserLang;
      applyTranslations();
      // Still do IP check in background to confirm/correct
    }

    // 3. IP-based detection (more accurate for country-specific dialects)
    let countryCode="IT";
    try{
      const r=await fetch("https://ipapi.co/json/",{signal:AbortSignal.timeout(5000)});
      const d=await r.json();
      countryCode=d.country_code||countryCode;
    }catch{
      // Fallback: try alternative IP service
      try{
        const r2=await fetch("https://api.country.is/",{signal:AbortSignal.timeout(3000)});
        const d2=await r2.json();
        countryCode=d2.country||countryCode;
      }catch{}
    }

    userRegion=countryCode;
    const lang=COUNTRY_LANG[countryCode]||(LANGS[browserLang]?browserLang:"it");
    currentLang=lang;
    localStorage.setItem("sv_lang",lang);
    applyTranslations();

    // 4. Reload content in detected language
    _apiCache.clear();
    await Promise.all([loadHero(),loadHomeMovies(),loadHomeShows(),loadHomeTrending()]);

    // 5. Show banner only if non-English/Italian was auto-detected
    const flag=LANG_FLAGS[lang]||"🌍";
    const name=LANG_NAMES_FULL[lang]||LANG_CODES_UC[lang]||lang.toUpperCase();
    showDetectBanner("lang","ok",flag,
      `Lingua rilevata: ${flag} ${name}`,
      `Player e contenuti impostati su ${name}. Modifica dalla sidebar.`
    );
  }catch(e){
    console.warn("detectLanguage:",e);
    if(!localStorage.getItem("sv_lang")){currentLang="it";applyTranslations()}
  }
}

// ── SIDEBAR ───────────────────────────────────────────────────────
function openSidebar(){
  const s=document.getElementById("sidebar");
  const o=document.getElementById("sidebar-overlay");
  s?.classList.add("open");
  o?.classList.add("open");
  document.body.style.overflow="hidden";
}
function closeSidebar(){
  const s=document.getElementById("sidebar");
  const o=document.getElementById("sidebar-overlay");
  s?.classList.remove("open");
  o?.classList.remove("open");
  if(!document.getElementById("detail-modal")?.classList.contains("open"))
    document.body.style.overflow="";
}

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(msg,type="info"){
  const el=document.getElementById("toast");
  if(!el) return;
  el.textContent=msg;el.className="show "+type;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.className="",2600);
}

// ── POPUPS ────────────────────────────────────────────────────────
function openPopup(id){
  document.querySelectorAll(".popup-overlay").forEach(p=>p.classList.remove("open"));
  document.getElementById(id)?.classList.add("open");
  document.body.style.overflow="hidden";
}
function closePopup(id){
  document.getElementById(id)?.classList.remove("open");
  if(!document.getElementById("detail-modal")?.classList.contains("open"))
    document.body.style.overflow="";
}

// ── NAVIGATION ────────────────────────────────────────────────────
function navigate(page){
  currentPage=page;
  closeSidebar();
  document.querySelectorAll(".page-view").forEach(p=>p.classList.remove("active"));
  document.getElementById("page-"+page)?.classList.add("active");
  // Sync sidebar links
  document.querySelectorAll(".sidebar-link[data-page]").forEach(el=>
    el.classList.toggle("active",el.dataset.page===page));
  // Sync bottom nav
  document.querySelectorAll(".bnav-item[data-page]").forEach(el=>
    el.classList.toggle("active",el.dataset.page===page));
  updateTopbarTitle();
  // Use scrollTo only if not already at top (perf)
  if(window.scrollY>0) window.scrollTo({top:0,behavior:"smooth"});
  // Lazy-load pages
  if(page==="movies"&&!document.getElementById("movies-browse-grid")?.children.length) initMoviesBrowse();
  if(page==="shows" &&!document.getElementById("shows-browse-grid")?.children.length)  initShowsBrowse();
  if(page==="trending"&&!document.getElementById("trending-grid")?.children.length)     initTrending();
  if(page==="wishlist") renderWishlist();
}

// ── WISHLIST ──────────────────────────────────────────────────────
function loadWishlist(){try{wishlist=JSON.parse(localStorage.getItem("sv_wishlist")||"[]")}catch{wishlist=[]}}
function saveWishlist(){
  try{localStorage.setItem("sv_wishlist",JSON.stringify(wishlist))}catch(e){
    // localStorage full — trim oldest entries
    if(wishlist.length>20) wishlist=wishlist.slice(-20);
    localStorage.setItem("sv_wishlist",JSON.stringify(wishlist));
  }
}
function isInWishlist(id){return wishlist.some(i=>i.id===id)}
function toggleWishlist(id,title,poster,type,year){
  const idx=wishlist.findIndex(i=>i.id===id);
  if(idx>-1){wishlist.splice(idx,1);showToast(t("removed_wl"),"info")}
  else{wishlist.push({id,title,poster,type,year});showToast(t("added_wl"),"success")}
  saveWishlist();updateWishlistCount();
  document.querySelectorAll(`[data-wl-id="${id}"]`).forEach(el=>{
    el.classList.toggle("active",isInWishlist(id));
    el.innerHTML=isInWishlist(id)?"❤":"♡";
  });
}
function updateWishlistCount(){
  const n=wishlist.length;
  const b=document.getElementById("wl-count");
  if(b){b.textContent=n;b.style.display=n?"flex":"none"}
  const sb=document.getElementById("sidebar-wl-badge");
  if(sb){sb.textContent=n;sb.style.display=n?"inline-flex":"none"}
  const dot=document.getElementById("bnav-wl-dot");
  if(dot) dot.style.display=n?"block":"none";
}
function clearWishlist(){wishlist=[];saveWishlist();updateWishlistCount();renderWishlist()}
function renderWishlist(){
  const grid=document.getElementById("wishlist-grid");
  const empty=document.getElementById("wishlist-empty");
  const clearBtn=document.getElementById("wl-clear-btn");
  if(!grid||!empty) return;
  grid.innerHTML="";
  if(!wishlist.length){empty.style.display="flex";if(clearBtn)clearBtn.style.display="none";return}
  empty.style.display="none";if(clearBtn)clearBtn.style.display="flex";
  // DocumentFragment for batch DOM insert
  const frag=document.createDocumentFragment();
  wishlist.forEach((item,i)=>frag.appendChild(buildCard({
    id:item.id,title:item.title,_poster_full:item.poster,poster_path:null,type:item.type,
    release_date:item.type!=="tv"?item.year+"-01-01":"",
    first_air_date:item.type==="tv"?item.year+"-01-01":"",
  },{idx:i})));
  grid.appendChild(frag);
  _observeLazyImgs(grid);
}

// ── CARD ──────────────────────────────────────────────────────────
function buildCard(item,opts={}){
  const isTV  = !!item.first_air_date||item.media_type==="tv"||item.type==="tv";
  const title = item.title||item.name||"Unknown";
  const year  = (item.release_date||item.first_air_date||"").slice(0,4);
  const score = item.vote_average?item.vote_average.toFixed(1):"";
  const img   = item._poster_full||posterUrl(item.poster_path);
  const type  = isTV?"tv":"movie";
  const inWL  = isInWishlist(item.id);
  const id    = item.id;

  const div=document.createElement("div");
  div.className="card";
  div.style.animationDelay=`${Math.min((opts.idx||0)*.035,.5)}s`;

  // Use data-src for lazy loading
  const imgHtml=`<img class="card-poster" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 3'%3E%3C/svg%3E" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async" onerror="this.src='https://placehold.co/342x513/13131F/6246EA?text=?';this.removeAttribute('data-src')">`;

  div.innerHTML=`
    <div class="card-poster-wrap">
      ${imgHtml}
      <div class="card-gradient"></div>
      <div class="card-type">${isTV?"📺":"🎬"}</div>
      <button class="card-wl${inWL?" active":""}" data-wl-id="${id}"
        onclick="event.stopPropagation();toggleWishlist(${id},'${esc(title).replace(/'/g,"\\'")}','${esc(img)}','${type}','${year}')"
        aria-label="${inWL?"Rimuovi da":"Aggiungi a"} wishlist">
        ${inWL?"❤":"♡"}
      </button>
      ${score?`<div class="card-score-badge">⭐ ${score}</div>`:""}
      <div class="card-hover-layer">
        <div class="card-hover-title">${esc(title)}</div>
        <div class="card-hover-meta">
          ${year?`<span>${year}</span>`:""}
          ${year&&score?`<span style="width:2px;height:2px;background:rgba(255,255,255,.3);border-radius:50%;display:inline-block"></span>`:""}
          ${score?`<span>⭐ ${score}</span>`:""}
        </div>
        <button class="card-play-btn" onclick="event.stopPropagation();openDetail(${id},'${type}')">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          ${t("watch_now")}
        </button>
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${esc(title)}</div>
      <div class="card-meta-row">
        ${year?`<span class="card-year">${year}</span>`:""}
        ${score?`<span class="card-score">⭐ ${score}</span>`:""}
        ${item.original_language&&item.original_language!=="--"?`<span class="card-lang-tag">${esc(item.original_language.toUpperCase())}</span>`:""}
      </div>
    </div>`;

  div.addEventListener("click",e=>{if(e.target.closest(".card-wl"))return;openDetail(id,type)});
  return div;
}

function _observeLazyImgs(container){
  if(!_imgObserver) return;
  container.querySelectorAll("img[data-src]").forEach(img=>_imgObserver.observe(img));
}

// Batch render with DocumentFragment
function renderGrid(container,items){
  if(!container) return;
  if(!items?.length){container.innerHTML=`<div class="no-results">${t("no_results")}</div>`;return}
  const frag=document.createDocumentFragment();
  items.forEach((item,i)=>frag.appendChild(buildCard(item,{idx:i})));
  container.innerHTML="";
  container.appendChild(frag);
  _observeLazyImgs(container);
}
function appendGrid(container,items,startIdx=0){
  if(!container||!items?.length) return;
  const frag=document.createDocumentFragment();
  items.forEach((item,i)=>frag.appendChild(buildCard(item,{idx:startIdx+i})));
  container.appendChild(frag);
  _observeLazyImgs(container);
}

// ── HERO ──────────────────────────────────────────────────────────
async function loadHero(){
  const data=await tmdb("/trending/all/week");
  if(!data?.results?.length) return;
  heroPool=data.results.filter(i=>i.backdrop_path&&(i.media_type==="movie"||i.media_type==="tv")).slice(0,8);
  if(!heroPool.length) return;
  renderHero(0);buildHeroIndicators();
  clearInterval(heroTimer);
  heroTimer=setInterval(()=>{heroIdx=(heroIdx+1)%heroPool.length;renderHero(heroIdx)},9000);
}
function renderHero(idx){
  heroIdx=idx;
  const item=heroPool[idx];
  if(!item) return;
  window._heroCurrentId=item.id;
  window._heroCurrentType=item.media_type||"movie";
  const bg=document.getElementById("hero-bg");
  if(bg){
    bg.style.opacity="0";
    setTimeout(()=>{
      bg.style.backgroundImage=`url('${backdropUrl(item.backdrop_path,"original")}')`;
      bg.style.opacity="1";
    },280);
  }
  const titleEl=document.getElementById("hero-title");
  if(titleEl){
    titleEl.style.opacity="0";
    setTimeout(()=>{titleEl.textContent=item.title||item.name||"";titleEl.style.opacity="1"},280);
  }
  const descEl=document.getElementById("hero-desc");
  if(descEl){const ov=item.overview||"";descEl.textContent=ov.length>220?ov.slice(0,220)+"…":ov}
  const metaEl=document.getElementById("hero-meta");
  if(metaEl) metaEl.innerHTML=`
    ${(item.release_date||item.first_air_date)?`<div class="hero-chip">${(item.release_date||item.first_air_date||"").slice(0,4)}</div>`:""}
    ${item.vote_average?`<div class="hero-chip hero-rating">⭐ ${item.vote_average.toFixed(1)}</div>`:""}
    <div class="hero-chip">${item.media_type==="tv"?"Serie TV":"Film"}</div>`;
  document.querySelectorAll(".hero-ind").forEach((d,i)=>d.classList.toggle("active",i===idx));
}
function buildHeroIndicators(){
  const wrap=document.getElementById("hero-indicators");
  if(!wrap) return;
  wrap.innerHTML="";
  heroPool.forEach((_,i)=>{
    const d=document.createElement("div");
    d.className="hero-ind"+(i===0?" active":"");
    d.onclick=()=>{clearInterval(heroTimer);renderHero(i);heroTimer=setInterval(()=>{heroIdx=(heroIdx+1)%heroPool.length;renderHero(heroIdx)},9000)};
    wrap.appendChild(d);
  });
}
function heroPlay(){if(window._heroCurrentId)openDetail(window._heroCurrentId,window._heroCurrentType||"movie")}
function heroInfo(){heroPlay()}

// ── HOME DATA ─────────────────────────────────────────────────────
async function loadHomeTrending(){
  const data=await tmdb("/trending/all/week");
  const row=document.getElementById("trending-row");
  if(!row) return;
  row.innerHTML="";
  const frag=document.createDocumentFragment();
  data?.results?.slice(0,16).forEach((item,i)=>frag.appendChild(buildCard(item,{idx:i})));
  row.appendChild(frag);
  _observeLazyImgs(row);
}
async function loadHomeMovies(){
  const data=await tmdb("/movie/popular",{page:1});
  renderGrid(document.getElementById("movies-grid"),data?.results?.slice(0,12));
}
async function loadHomeShows(){
  const data=await tmdb("/tv/popular",{page:1});
  renderGrid(document.getElementById("shows-grid"),data?.results?.slice(0,12));
}

// ── GENRE FILTERS ─────────────────────────────────────────────────
function buildGenreFilters(id,genres,activeId,onSelect){
  const bar=document.getElementById(id);
  if(!bar) return;
  const frag=document.createDocumentFragment();
  genres.forEach(g=>{
    const btn=document.createElement("button");
    btn.className="genre-pill"+(g.id===activeId?" active":"");
    btn.textContent=g.key?t(g.key):g.label;
    btn.onclick=()=>onSelect(g.id);
    frag.appendChild(btn);
  });
  bar.innerHTML="";
  bar.appendChild(frag);
}

// ── BROWSE ────────────────────────────────────────────────────────
async function initMoviesBrowse(){
  moviesBrowsePage=1;moviesBrowseGenre="";
  buildGenreFilters("movie-genre-filters",MOVIE_GENRES,"",g=>{
    moviesBrowseGenre=g;moviesBrowsePage=1;
    buildGenreFilters("movie-genre-filters",MOVIE_GENRES,g,()=>{});
    initMoviesBrowseFetch(true);
  });
  await initMoviesBrowseFetch(true);
}
async function initMoviesBrowseFetch(reset=false){
  if(reset) moviesBrowsePage=1;
  const grid=document.getElementById("movies-browse-grid");
  if(!grid) return;
  if(reset) grid.innerHTML=Array(12).fill('<div class="skeleton skel-poster"></div>').join("");
  const ep=moviesBrowseGenre?"/discover/movie":"/movie/popular";
  const params={page:moviesBrowsePage};
  if(moviesBrowseGenre) params.with_genres=moviesBrowseGenre;
  const data=await tmdb(ep,params);
  const startIdx=reset?0:(moviesBrowsePage-1)*20;
  if(reset) grid.innerHTML="";
  appendGrid(grid,data?.results,startIdx);
  moviesBrowsePage++;
}
function loadMoreMovies(){initMoviesBrowseFetch(false)}

async function initShowsBrowse(){
  showsBrowsePage=1;showsBrowseGenre="";
  buildGenreFilters("show-genre-filters",TV_GENRES,"",g=>{
    showsBrowseGenre=g;showsBrowsePage=1;
    buildGenreFilters("show-genre-filters",TV_GENRES,g,()=>{});
    initShowsBrowseFetch(true);
  });
  await initShowsBrowseFetch(true);
}
async function initShowsBrowseFetch(reset=false){
  if(reset) showsBrowsePage=1;
  const grid=document.getElementById("shows-browse-grid");
  if(!grid) return;
  if(reset) grid.innerHTML=Array(12).fill('<div class="skeleton skel-poster"></div>').join("");
  const ep=showsBrowseGenre?"/discover/tv":"/tv/popular";
  const params={page:showsBrowsePage};
  if(showsBrowseGenre) params.with_genres=showsBrowseGenre;
  const data=await tmdb(ep,params);
  const startIdx=reset?0:(showsBrowsePage-1)*20;
  if(reset) grid.innerHTML="";
  appendGrid(grid,data?.results,startIdx);
  showsBrowsePage++;
}
function loadMoreShows(){initShowsBrowseFetch(false)}

async function initTrending(){
  const data=await tmdb("/trending/all/week");
  renderGrid(document.getElementById("trending-grid"),data?.results);
}

// ── SEARCH (debounced, cached) ─────────────────────────────────────
function setupSearch(){
  const si=document.getElementById("search-input");
  const dd=document.getElementById("search-dropdown");
  if(!si||!dd) return;
  si.addEventListener("input",e=>{
    clearTimeout(searchTimer);
    const q=e.target.value.trim();
    if(!q){dd.className="";return}
    dd.className="open";
    dd.innerHTML='<div style="padding:12px;color:var(--txt3);font-size:11px">Ricerca…</div>';
    searchTimer=setTimeout(()=>doSearch(q,dd),380);
  });
  si.addEventListener("blur",()=>setTimeout(()=>dd.className="",180));
  si.addEventListener("focus",()=>{if(si.value.trim())dd.className="open"});
  // Mobile: close on Enter
  si.addEventListener("keydown",e=>{if(e.key==="Enter"){clearTimeout(searchTimer);doSearch(si.value.trim(),dd)}});
}
async function doSearch(q,dd){
  if(!q) return;
  const data=await tmdb("/search/multi",{query:q,include_adult:false,page:1});
  const items=(data?.results||[]).filter(i=>i.media_type==="movie"||i.media_type==="tv").slice(0,8);
  if(!items.length){dd.innerHTML=`<div style="padding:12px;color:var(--txt3);font-size:11px">${t("no_results")}</div>`;return}
  const frag=document.createDocumentFragment();
  // External links row
  const sitesRow=document.createElement("div");
  sitesRow.style.cssText="display:flex;gap:6px;padding:9px 11px 7px;border-bottom:1px solid var(--border);flex-wrap:wrap";
  [{name:"Google",icon:"G",url:q=>`https://www.google.com/search?q=${encodeURIComponent(q+" streaming")}`},
   {name:"JustWatch",icon:"JW",url:q=>`https://www.justwatch.com/it/search?q=${encodeURIComponent(q)}`},
   {name:"IMDb",icon:"IMDb",url:q=>`https://www.imdb.com/find/?q=${encodeURIComponent(q)}`}
  ].forEach(site=>{
    const a=document.createElement("a");
    a.href=site.url(q);a.target="_blank";a.rel="noopener noreferrer";
    a.style.cssText="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:16px;background:var(--surface3);font-size:10px;font-weight:500;color:var(--txt2)";
    a.textContent=site.name;
    sitesRow.appendChild(a);
  });
  frag.appendChild(sitesRow);
  items.forEach(item=>{
    const isTV=item.media_type==="tv";
    const title=item.title||item.name||"";
    const year=(item.release_date||item.first_air_date||"").slice(0,4);
    const img=item.poster_path?`${TMDB_IMG}w92${item.poster_path}`:"https://placehold.co/34x50/13131F/6246EA?text=?";
    const row=document.createElement("div");
    row.style.cssText="display:flex;align-items:center;gap:10px;padding:8px 11px;cursor:pointer;transition:background .12s";
    row.onmouseenter=()=>row.style.background="var(--surface3)";
    row.onmouseleave=()=>row.style.background="";
    row.innerHTML=`
      <img src="${esc(img)}" style="width:32px;height:48px;object-fit:cover;border-radius:5px;flex-shrink:0" loading="lazy" decoding="async" onerror="this.src='https://placehold.co/32x48/13131F/6246EA?text=?'">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
        <div style="font-size:9px;color:var(--txt3);margin-top:1px">${year}${year?" · ":""}${isTV?"Serie TV":"Film"}</div>
      </div>`;
    row.onclick=()=>{openDetail(item.id,isTV?"tv":"movie");dd.className="";document.getElementById("search-input").value=""};
    frag.appendChild(row);
  });
  dd.innerHTML="";
  dd.appendChild(frag);
}

// ── DETAIL MODAL ──────────────────────────────────────────────────
async function openDetail(id,type="movie"){
  const modal=document.getElementById("detail-modal");
  if(!modal) return;
  modal.classList.add("open");
  document.body.style.overflow="hidden";
  // Reset UI fast
  document.getElementById("modal-title").textContent="…";
  document.getElementById("modal-plot").textContent="";
  document.getElementById("modal-chips").innerHTML="";
  document.getElementById("modal-hero-img").src="";
  document.getElementById("modal-actions").innerHTML="";
  document.getElementById("modal-hero-content").innerHTML="";
  modalStopPlayer();
  _mId=id;_mType=type;_mSeason=1;_mEpisode=1;_mEpCounts={};_mTotalSeasons=1;_currentSource=0;
  const epWrap=document.getElementById("modal-ep-wrap");
  if(epWrap) epWrap.style.display="none";

  const data=await tmdb(type==="tv"?`/tv/${id}`:`/movie/${id}`,{append_to_response:"videos,credits"});
  if(!data){closeModal();return}

  const title   = data.title||data.name||"";
  const year    = (data.release_date||data.first_air_date||"").slice(0,4);
  const rating  = data.vote_average?data.vote_average.toFixed(1):"";
  const runtime = data.runtime||(data.episode_run_time?.[0])||"";
  const genres  = (data.genres||[]).slice(0,3).map(g=>g.name);
  const trailer = (data.videos?.results||[]).find(v=>v.type==="Trailer"&&v.site==="YouTube");
  const director= (data.credits?.crew||[]).find(c=>c.job==="Director")?.name||"";
  const cast    = (data.credits?.cast||[]).slice(0,4).map(c=>c.name).join(", ");

  const heroSrc=backdropUrl(data.backdrop_path,"original")||posterUrl(data.poster_path,"w780");
  const heroImg=document.getElementById("modal-hero-img");
  heroImg.src=heroSrc;heroImg.alt=title;
  document.getElementById("modal-title").textContent=title;
  document.getElementById("modal-plot").textContent=data.overview||"";
  document.getElementById("modal-chips").innerHTML=`
    ${year?`<span class="chip chip-year">${year}</span>`:""}
    ${type==="tv"?`<span class="chip chip-type">Serie TV</span>`:`<span class="chip chip-type">Film</span>`}
    ${rating?`<span class="chip chip-rating">⭐ ${rating}</span>`:""}
    ${genres.map(g=>`<span class="chip chip-genre">${esc(g)}</span>`).join("")}
    ${runtime?`<span class="chip chip-runtime">${runtime} min</span>`:""}`;

  const heroContent=document.getElementById("modal-hero-content");
  if(heroContent&&(director||cast)){
    heroContent.innerHTML=`<div style="max-width:380px">
      ${director?`<div style="font-size:9px;color:rgba(255,255,255,.45);margin-bottom:2px">Regia: <span style="color:rgba(255,255,255,.8);font-weight:500">${esc(director)}</span></div>`:""}
      ${cast?`<div style="font-size:9px;color:rgba(255,255,255,.45)">Cast: <span style="color:rgba(255,255,255,.65)">${esc(cast)}</span></div>`:""}
    </div>`;
  }

  if(type==="tv"){
    _mTotalSeasons=data.number_of_seasons||1;
    if(epWrap){epWrap.style.display="flex";await _populateSeasons(_mId,_mTotalSeasons)}
  }
  _buildSourceButtons();

  // Actions
  const actDiv=document.getElementById("modal-actions");
  actDiv.innerHTML="";
  if(trailer){
    const tb=document.createElement("a");
    tb.className="btn-ghost btn-sm";
    tb.href=`https://www.youtube.com/watch?v=${trailer.key}`;
    tb.target="_blank";tb.rel="noopener noreferrer";
    tb.innerHTML=`<svg viewBox="0 0 24 24" fill="currentColor" style="width:11px;height:11px"><polygon points="5,3 19,12 5,21"/></svg> Trailer`;
    actDiv.appendChild(tb);
  }
  const inWL=isInWishlist(id);
  const wlBtn=document.createElement("button");
  wlBtn.className="btn-ghost btn-sm"+(inWL?" active":"");
  wlBtn.innerHTML=`${inWL?"❤":"♡"} Wishlist`;
  wlBtn.onclick=()=>{
    toggleWishlist(id,title,posterUrl(data.poster_path),type,year);
    const now=isInWishlist(id);
    wlBtn.innerHTML=`${now?"❤":"♡"} Wishlist`;
    wlBtn.classList.toggle("active",now);
  };
  actDiv.appendChild(wlBtn);
  const cb=document.createElement("button");
  cb.className="btn-ghost btn-sm";
  cb.innerHTML="✕ Chiudi";
  cb.onclick=closeModal;
  actDiv.appendChild(cb);
}

// ── SOURCE BUTTONS ────────────────────────────────────────────────
function _buildSourceButtons(){
  const container=document.getElementById("source-btns");
  if(!container) return;
  const frag=document.createDocumentFragment();
  SOURCES.forEach((src,i)=>{
    const btn=document.createElement("button");
    btn.className="source-btn"+(i===_currentSource?" active":"");
    btn.dataset.idx=String(i);
    btn.textContent=src.short;
    // Tooltip: full name + lang support indicator
    btn.title=src.label+(src.langSupport?" ✓ "+( LANG_NAMES_FULL[currentLang]||currentLang.toUpperCase()):"");
    btn.onclick=()=>_switchSource(i);
    // Dot prefix
    const dot=document.createElement("span");
    dot.className="source-dot";
    btn.prepend(dot);
    frag.appendChild(btn);
  });
  container.innerHTML="";
  container.appendChild(frag);
}
function _switchSource(idx){
  _currentSource=idx;
  _setBestSourceIdx(idx);
  document.querySelectorAll(".source-btn").forEach((b,i)=>b.classList.toggle("active",i===idx));
  if(document.getElementById("modal-hero")?.classList.contains("playing")) _loadPlayerUrl();
}

// ── EPISODE CONTROLS ──────────────────────────────────────────────
async function _populateSeasons(tmdbId,total){
  const sel=document.getElementById("modal-season-sel");
  if(!sel) return;
  let html="";
  for(let s=1;s<=total;s++) html+=`<option value="${s}">S${s}</option>`;
  sel.innerHTML=html;sel.value=1;
  await _loadEps(tmdbId,1);_populateEps(1);
}
async function _loadEps(tmdbId,season){
  if(_mEpCounts[season]) return;
  try{
    const r=await fetch(`${TMDB_BASE}/tv/${tmdbId}/season/${season}?api_key=${TMDB_KEY}&language=${tmdbLang()}`);
    const d=await r.json();
    _mEpCounts[season]=d.episodes?.length||10;
  }catch{_mEpCounts[season]=10}
}
function _populateEps(season){
  const sel=document.getElementById("modal-ep-sel");
  if(!sel) return;
  const count=_mEpCounts[season]||10;
  let html="";
  for(let e=1;e<=count;e++) html+=`<option value="${e}">E${e}</option>`;
  sel.innerHTML=html;sel.value=1;
}
async function modalSeasonChange(){
  const ss=document.getElementById("modal-season-sel");
  if(!ss) return;
  _mSeason=parseInt(ss.value)||1;
  await _loadEps(_mId,_mSeason);
  _populateEps(_mSeason);
  _mEpisode=1;
  if(document.getElementById("modal-hero")?.classList.contains("playing")) _loadPlayerUrl();
}
function modalEpChange(){
  const es=document.getElementById("modal-ep-sel");
  if(!es) return;
  _mEpisode=parseInt(es.value)||1;
  if(document.getElementById("modal-hero")?.classList.contains("playing")) _loadPlayerUrl();
}

// ══════════════════════════════════════════════════════════════════
//  SMART PLAYER SYSTEM v2 — fixed
//  Flow:
//  1. User clicks Play → show loading spinner overlay
//  2. Immediately try sources in order (no slow HEAD probing)
//     - Start with saved best source for this lang (sessionStorage)
//     - langSupport sources come first
//  3. Load iframe → listen for load event (2s timeout per source)
//  4. If iframe loads → show it, done
//  5. After trying N sources → show subs-only notice and load anyway
// ══════════════════════════════════════════════════════════════════

function _loadPlayerUrl(){
  const iframe=document.getElementById("modal-hero-player");
  if(!iframe||!_mId) return;
  const src=SOURCES[_currentSource];
  if(!src) return;
  const url=src.build({id:_mId,type:_mType,season:_mSeason,episode:_mEpisode,lang:currentLang});
  console.log(`[SV] Loading ${src.label} [${currentLang}]:`,url);
  iframe.src=url;
}

// ── Lang status chip (shown inside player controls overlay) ──
function _showLangStatus(msg,type="ok"){
  const el=document.getElementById("lang-status-chip");
  if(!el) return;
  const styles={
    ok:   "background:rgba(0,229,176,.18);color:#00E5B0;border:1px solid rgba(0,229,176,.38)",
    warn: "background:rgba(245,200,66,.18);color:#F5C842;border:1px solid rgba(245,200,66,.38)",
    info: "background:rgba(98,70,234,.18);color:#B3A0FF;border:1px solid rgba(98,70,234,.38)",
    error:"background:rgba(255,94,106,.18);color:#FF5E6A;border:1px solid rgba(255,94,106,.38)"
  };
  el.style.cssText=`display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;flex-shrink:0;white-space:nowrap;${styles[type]||styles.info}`;
  el.textContent=msg;
}
function _hideLangStatus(){
  const el=document.getElementById("lang-status-chip");
  if(el){ el.style.cssText="display:none"; el.textContent="" }
}

// ── Subs-only notice (shown below player, inside modal-body) ──
const SUBS_ONLY_MSG={
  it:(n,f)=>`${f} Doppiaggio <strong>${n}</strong> non trovato su questo server — disponibili <strong>sottotitoli</strong>. Prova un altro server.`,
  en:(n,f)=>`${f} No <strong>${n}</strong> dub found — <strong>subtitles</strong> available. Try another server.`,
  es:(n,f)=>`${f} Sin doblaje en <strong>${n}</strong> — solo <strong>subtítulos</strong>. Prueba otro servidor.`,
  fr:(n,f)=>`${f} Pas de doublage <strong>${n}</strong> — <strong>sous-titres</strong> disponibles. Essayez un autre serveur.`,
  de:(n,f)=>`${f} Kein <strong>${n}</strong> Dub — nur <strong>Untertitel</strong>. Anderen Server ausprobieren.`,
  pt:(n,f)=>`${f} Sem dublagem em <strong>${n}</strong> — apenas <strong>legendas</strong>. Tente outro servidor.`,
  ja:(n,f)=>`${f} <strong>${n}</strong>吹き替えなし — <strong>字幕</strong>のみ。他のサーバーをお試しください。`,
  zh:(n,f)=>`${f} 无<strong>${n}</strong>配音 — 仅<strong>字幕</strong>。请尝试其他服务器。`,
  ko:(n,f)=>`${f} <strong>${n}</strong> 더빙 없음 — <strong>자막</strong>만 가능. 다른 서버를 시도하세요.`,
  ru:(n,f)=>`${f} Дубляж <strong>${n}</strong> не найден — только <strong>субтитры</strong>. Попробуйте другой сервер.`,
  ar:(n,f)=>`${f} لا يوجد دبلجة <strong>${n}</strong> — <strong>ترجمة</strong> فقط. جرّب خادماً آخر.`,
  hi:(n,f)=>`${f} <strong>${n}</strong> डबिंग नहीं मिली — केवल <strong>उपशीर्षक</strong>. दूसरा सर्वर आज़माएं.`,
};
function _showSubsOnlyNotice(lang){
  _hideSubsOnlyNotice();
  const flag=LANG_FLAGS[lang]||"🌍";
  const name=LANG_NAMES_FULL[lang]||lang.toUpperCase();
  const msgFn=SUBS_ONLY_MSG[lang]||SUBS_ONLY_MSG.en;
  const el=document.createElement("div");
  el.id="subs-only-notice";
  el.style.cssText="display:flex;align-items:center;gap:10px;background:rgba(245,200,66,.07);border:1px solid rgba(245,200,66,.28);border-radius:10px;padding:10px 14px;margin:10px 14px 0;font-size:11px;font-weight:500;color:#F5C842;line-height:1.5;animation:fadeUp .3s ease";
  el.innerHTML=`<span style="font-size:18px;flex-shrink:0">${flag}</span><span style="flex:1">${msgFn(name,flag)}</span><button onclick="this.parentElement.remove()" style="margin-left:4px;background:none;border:none;color:rgba(255,255,255,.35);cursor:pointer;font-size:15px;flex-shrink:0;line-height:1">✕</button>`;
  // Insert after modal-actions
  const actions=document.getElementById("modal-actions");
  if(actions) actions.insertAdjacentElement("afterend",el);
  else document.getElementById("modal-body")?.appendChild(el);
}
function _hideSubsOnlyNotice(){ document.getElementById("subs-only-notice")?.remove() }

// ── Loading spinner overlay on play button ──
function _showPlayLoading(){
  const btn=document.getElementById("modal-play-btn");
  if(btn) btn.innerHTML=`<svg viewBox="0 0 24 24" style="width:28px;height:28px;animation:spin 1s linear infinite" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity=".25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
}
function _hidePlayLoading(){
  const btn=document.getElementById("modal-play-btn");
  if(btn) btn.innerHTML=`<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
}

// ── Quality selector UI ──
function _renderQualityRow(){
  const wrap=document.getElementById("modal-player-controls");
  if(!wrap) return;
  // Remove old quality row if any
  document.getElementById("quality-row")?.remove();
  const row=document.createElement("div");
  row.id="quality-row";
  row.style.cssText="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:2px";
  const label=document.createElement("span");
  label.style.cssText="font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--txt3);flex-shrink:0";
  label.textContent="QUALITÀ";
  row.appendChild(label);
  [["auto","Auto (720p)"],["1080p","🔒 1080p"]].forEach(([val,lbl])=>{
    if(val==="1080p"&&!_CAN_1080P){
      const btn=document.createElement("button");
      btn.className="source-btn";
      btn.style.cssText="opacity:.7;cursor:pointer";
      btn.innerHTML=`<span style="font-size:11px">🔒</span> 1080p <span style="font-size:9px;background:rgba(245,200,66,.18);color:#F5C842;border:1px solid rgba(245,200,66,.35);border-radius:10px;padding:1px 6px;margin-left:2px">VIP</span>`;
      btn.onclick=()=>{ openPopup("popup-ranks"); };
      row.appendChild(btn);
      return;
    }
    const btn=document.createElement("button");
    btn.className="source-btn"+((_currentQuality===val)?" active":"");
    btn.dataset.qual=val;
    btn.textContent=val==="auto"?"Auto (720p)":"1080p";
    btn.onclick=()=>{
      if(_currentQuality===val) return;
      _currentQuality=val;
      row.querySelectorAll(".source-btn[data-qual]").forEach(b=>b.classList.toggle("active",b.dataset.qual===val));
      // Reload player with new quality
      const iframe=document.getElementById("modal-hero-player");
      if(iframe&&document.getElementById("modal-hero")?.classList.contains("playing")){
        _loadPlayerUrl();
      }
    };
    row.appendChild(btn);
  });
  // Insert before episode selector or append
  const epWrap=document.getElementById("modal-ep-wrap");
  if(epWrap) wrap.insertBefore(row,epWrap);
  else wrap.appendChild(row);
}

// ── Main: auto-start with vixsrc.to ──
async function modalStartPlayer(){
  const hero=document.getElementById("modal-hero");
  if(!hero||!_mId) return;
  // Prevent double-tap
  if(hero.classList.contains("playing")) return;

  _hideSubsOnlyNotice();
  _hideLangStatus();

  _currentSource=0;
  hero.classList.add("playing");
  document.getElementById("modal-player-controls")?.classList.add("visible");
  _renderQualityRow();
  _loadPlayerUrl();
}

function modalStopPlayer(){
  const iframe=document.getElementById("modal-hero-player");
  const hero=document.getElementById("modal-hero");
  if(iframe){ iframe.src="about:blank" }
  if(hero){ hero.classList.remove("playing") }
  document.getElementById("modal-player-controls")?.classList.remove("visible");
  document.getElementById("quality-row")?.remove();
  _currentQuality="auto";
  _hidePlayLoading();
  _hideLangStatus();
  _hideSubsOnlyNotice();
}

function _syncSourceButtons(){
  document.querySelectorAll(".source-btn").forEach((b,i)=>b.classList.toggle("active",i===_currentSource));
}

function closeModal(){
  document.getElementById("detail-modal")?.classList.remove("open");
  document.body.style.overflow="";
  modalStopPlayer();
}

// ── DETECT BANNERS ────────────────────────────────────────────────
function showDetectBanner(id,type,icon,title,sub){
  const c=document.getElementById("detect-banners");
  if(!c||document.getElementById("detect-"+id)) return;
  const div=document.createElement("div");
  div.id="detect-"+id;
  div.className=`detect-banner ${type}`;
  div.innerHTML=`<div class="detect-icon">${icon}</div><div class="detect-body"><div class="detect-title">${title}</div><div class="detect-sub">${sub}</div></div><div class="detect-close" onclick="this.closest('.detect-banner').remove()">✕</div>`;
  c.appendChild(div);
  setTimeout(()=>div.remove(),11000);
}
async function runDetections(){
  // AdBlocker
  setTimeout(()=>{
    const bait=document.createElement("div");
    bait.className="adsbygoogle adsbox";
    bait.style.cssText="position:absolute;left:-9999px;height:1px;width:1px";
    document.body.appendChild(bait);
    setTimeout(()=>{
      if(bait.offsetHeight===0) showDetectBanner("adblocker","warn","🛡️","AdBlocker Rilevato","Alcuni player potrebbero non funzionare.");
      bait.remove();
    },200);
  },2200);
  // HTTPS
  if(location.protocol!=="https:"&&location.hostname!=="localhost")
    showDetectBanner("http","warn","🔓","HTTP rilevato","Usa HTTPS per il corretto funzionamento dei player.");
  // Mobile hint
  if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
    setTimeout(()=>showDetectBanner("mobile","info","📱","Modalità Mobile","Ruota in landscape e premi fullscreen per la migliore esperienza."),3500);
}

// ── PERFORMANCE: Infinite scroll for browse pages ─────────────────
function setupInfiniteScroll(){
  if(!('IntersectionObserver' in window)) return;
  // Observe load-more buttons
  const observer=new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        if(currentPage==="movies") loadMoreMovies();
        if(currentPage==="shows") loadMoreShows();
      }
    });
  },{rootMargin:"400px"});
  // We'll re-attach when needed
  window._infiniteObserver=observer;
}

// ── PERFORMANCE: Prefetch on hover/touchstart ──────────────────────
let _prefetchTimer=null;
function prefetchDetail(id,type){
  clearTimeout(_prefetchTimer);
  _prefetchTimer=setTimeout(()=>{
    // Warm the cache in background
    tmdb(type==="tv"?`/tv/${id}`:`/movie/${id}`,{append_to_response:"videos,credits"});
  },150);
}

// ── INIT ──────────────────────────────────────────────────────────
async function init(){
  // 1. Restore state
  loadWishlist();
  updateWishlistCount();
  const savedLang=localStorage.getItem("sv_lang");
  if(savedLang) currentLang=savedLang;

  // 2. Init performance systems
  initImgObserver();
  setupInfiniteScroll();

  // 3. Apply translations immediately (no layout shift)
  applyTranslations();

  // 4. Search setup
  setupSearch();

  // 5. Global keyboard
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){
      closeModal();
      document.querySelectorAll(".popup-overlay.open").forEach(p=>closePopup(p.id));
      closeSidebar();
    }
  });

  // 6. Popup backdrop
  document.querySelectorAll(".popup-overlay").forEach(ov=>{
    ov.addEventListener("click",e=>{if(e.target===ov)closePopup(ov.id)});
  });

  // 7. Swipe to close sidebar on mobile
  setupSwipe();

  // 8. Hide loader
  setTimeout(()=>{
    const l=document.getElementById("loader");
    if(l){l.classList.add("hidden");setTimeout(()=>l.remove(),550)}
  },650);

  // 9. Language detect (non-blocking)
  detectLanguage();

  // 10. Detections (low priority)
  setTimeout(runDetections,800);

  // 11. Load content in parallel (most important first)
  await Promise.all([loadHero(),loadHomeTrending(),loadHomeMovies(),loadHomeShows()]);
}

// ── SWIPE GESTURE (sidebar close on mobile) ────────────────────────
function setupSwipe(){
  let startX=0,startY=0;
  document.addEventListener("touchstart",e=>{
    startX=e.touches[0].clientX;
    startY=e.touches[0].clientY;
  },{passive:true});
  document.addEventListener("touchend",e=>{
    const dx=e.changedTouches[0].clientX-startX;
    const dy=Math.abs(e.changedTouches[0].clientY-startY);
    // Swipe left ≥ 60px, not mostly vertical → close sidebar
    if(dx<-60&&dy<50&&document.getElementById("sidebar")?.classList.contains("open")){
      closeSidebar();
    }
    // Swipe right from left edge → open sidebar (first 30px)
    if(dx>60&&dy<50&&startX<30&&!document.getElementById("detail-modal")?.classList.contains("open")){
      openSidebar();
    }
  },{passive:true});
}

// ── SERVICE WORKER registration for offline caching ────────────────
// Registers SW if supported — improves performance for repeat visitors
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    // Only register if sw.js exists (optional)
    navigator.serviceWorker.register('sw.js').catch(()=>{/* SW optional */});
  });
}

// ══════════════════════════════════════════════════════════════════
//  AD BLOCKER — blocca redirect e popup provenienti dal player
//  Tecnica: intercetta beforeunload, window.open, e link click
//  generati dall'iframe prima che raggiungano il browser
// ══════════════════════════════════════════════════════════════════
(function svAdBlock(){
  // 1. Blocca window.open() (popup pubblicitari)
  const _origOpen = window.open;
  window.open = function(url, target, features){
    // Permetti solo aperture esplicite dall'app stessa (es. fullscreen)
    // Blocca tutto il resto (chiamate senza stack trace dell'app)
    const stack = new Error().stack || "";
    // Se la chiamata NON viene da codice nostro (all.js/auth.js) → blocca
    if(!stack.includes("all.js") && !stack.includes("auth.js")){
      console.debug("[SVAdBlock] window.open bloccato:", url);
      return { closed: true, close(){}, focus(){}, location:{ href:"" } };
    }
    return _origOpen.call(window, url, target, features);
  };

  // 2. Blocca tentativi di modificare window.location dall'iframe
  //    tramite postMessage o link con target=_top/_parent
  window.addEventListener("message", function(e){
    // Ignora messaggi legittimi del player (PLAYER_EVENT da vixsrc)
    if(e.data && typeof e.data === "object" && e.data.type === "PLAYER_EVENT") return;
    // Blocca qualsiasi tentativo di navigazione top-level
    if(e.data && typeof e.data === "string"){
      const d = e.data.toLowerCase();
      if(d.includes("location") || d.includes("redirect") || d.includes("navigate")){
        console.debug("[SVAdBlock] postMessage sospetto bloccato:", e.data);
        e.stopImmediatePropagation();
      }
    }
  }, true);

  // 3. Intercetta beforeunload: se la pagina sta per uscire mentre
  //    il player è attivo, annulla e segnala all'utente
  let _playerActive = false;
  const _origModalStart = window.modalStartPlayer;
  const _origModalStop  = window.modalStopPlayer;
  // Patch dopo che all.js ha definito le funzioni (tick successivo)
  setTimeout(()=>{
    const origStart = window.modalStartPlayer;
    const origStop  = window.modalStopPlayer;
    window.modalStartPlayer = function(){
      _playerActive = true;
      return origStart && origStart.apply(this, arguments);
    };
    window.modalStopPlayer = function(){
      _playerActive = false;
      return origStop && origStop.apply(this, arguments);
    };
  }, 0);

  window.addEventListener("beforeunload", function(e){
    if(!_playerActive) return;
    // Se la navigazione NON è stata innescata da un click utente
    // (cioè viene dall'iframe) → annullala
    if(!e.isTrusted){
      e.preventDefault();
      e.returnValue = "";
      console.debug("[SVAdBlock] beforeunload non trusted bloccato");
    }
  });

  // 4. Intercetta click su <a> con target _blank / _top generati
  //    da script (non da gesti utente reali)
  document.addEventListener("click", function(e){
    const a = e.target.closest("a[target='_blank'], a[target='_top'], a[target='_parent']");
    if(!a) return;
    // Permetti se è un nostro link (dentro #detail-modal o nav)
    if(a.closest("#detail-modal, nav, #bottom-nav, #sidebar")) return;
    if(!e.isTrusted){
      e.preventDefault();
      e.stopImmediatePropagation();
      console.debug("[SVAdBlock] click non trusted bloccato:", a.href);
    }
  }, true);

})();

document.addEventListener("DOMContentLoaded",init);
