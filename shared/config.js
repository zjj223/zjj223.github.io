/* shared/config.js —— 站点配置只读镜像（B2 批次）
   owner: architect
   约定：
   1. 只读：本文件不改 window.SITE_CONFIG，只提供 LK.config 快照与读取函数。
   2. 旧 data/config.js 继续被页面直接使用；B2 阶段不切换，两边值必须一致。
   3. 功能开关默认全关，B2 期间不启用任何新路径。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  var BRAND = "俊杰侃信奥";
  var SITE_VERSION = "2026-11-28-b2";

  /* 功能开关：B2 只登记，不开。切换类工作由后续批次按页放行。 */
  var FEATURES = {
    sharedRoutes: false,
    sharedStorage: false,
    problemsApi: false,
    gameApi: false,
    uiNavigation: false,
    uiAuthModal: false
  };

  function siteConfig() {
    var raw = global.SITE_CONFIG;
    if (raw && typeof raw === "object") {
      return {
        brand: String(raw.brand || BRAND),
        exam: Array.isArray(raw.exam) ? raw.exam.slice() : [],
        matches: Array.isArray(raw.matches) ? raw.matches.slice() : [],
        mail: raw.mail && typeof raw.mail === "object" ? raw.mail : {},
        notices: Array.isArray(raw.notices) ? raw.notices.slice() : []
      };
    }
    /* 未加载旧配置时返回最小可用结构，不臆造业务值 */
    return { brand: BRAND, exam: [], matches: [], mail: {}, notices: [] };
  }

  function feature(name) {
    return !!FEATURES[name];
  }

  LK.config = {
    brand: BRAND,
    siteVersion: SITE_VERSION,
    features: FEATURES,
    siteConfig: siteConfig,
    feature: feature
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
