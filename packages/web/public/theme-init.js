// 渲染前恢复主题（避免深/浅色闪烁）；zustand persist 结构为 { state: {...} }
// v4.0 补 1：从 index.html 内联脚本外置为独立文件——服务端 CSP `script-src 'self'`
// 会拦截内联脚本（v4.0 审计批加的 CSP 头把令牌注入脚本与主题脚本一起拦掉，
// 生产页面重启后全部 API 401「缺少本地令牌」）；外置脚本经 'self' 放行，时序不变
// （无 defer/async 的 head 同步脚本，早于 type=module 的 bundle 执行）
(function () {
  var theme = "dark";
  try {
    var raw = localStorage.getItem("infu-chat");
    if (raw) {
      var parsed = JSON.parse(raw);
      var data = parsed && parsed.state ? parsed.state : parsed;
      if (data.theme === "light" || data.theme === "dark") theme = data.theme;
    }
  } catch (e) {
    /* 损坏的 localStorage 忽略，回落深色 */
  }
  document.documentElement.dataset.theme = theme;
})();
