/* 落地页脚本：入场动画、代码复制、年份。
   没有构建步骤，没有依赖，文件协议和 GitHub Pages 下都能直接跑。 */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 入场动画 ---------- */
  function setupReveal() {
    if (reduce || !('IntersectionObserver' in window)) return;
    var targets = [];
    document.querySelectorAll('.sect > .wrap, .stats__row, .cta__inner, .hero__copy, .hero__visual').forEach(function (el) {
      targets.push(el);
    });
    if (!targets.length) return;

    targets.forEach(function (el, i) {
      el.classList.add('reveal');
      el.style.transitionDelay = (i % 4) * 60 + 'ms';
    });

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
    );

    targets.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- 复制按钮 ---------- */
  function setupCopy() {
    document.querySelectorAll('.copy[data-copy-target]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sel = btn.getAttribute('data-copy-target');
        var node = sel ? document.querySelector(sel) : null;
        if (!node) return;
        var text = (node.textContent || '').trim();
        var prev = btn.textContent;

        function flash(ok) {
          btn.textContent = ok ? '已复制' : '复制失败';
          btn.setAttribute('data-state', ok ? 'done' : 'error');
          window.setTimeout(function () {
            btn.textContent = prev;
            btn.removeAttribute('data-state');
          }, 1600);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { flash(true); }, function () { flash(false); });
        } else {
          flash(false);
        }
      });
    });
  }

  function init() {
    setupReveal();
    setupCopy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
