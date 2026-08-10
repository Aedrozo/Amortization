/*!
 * charts.js — Dependency-free SVG charts with hover crosshairs and tooltips.
 *
 * Renders at the container's true pixel width (re-rendering on resize) rather
 * than scaling a fixed viewBox, so labels stay crisp and legible at every size.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Charts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) {
      if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    }
    return node;
  }

  function niceCeil(v) {
    if (v <= 0) return 1;
    var exp = Math.floor(Math.log10(v));
    var base = Math.pow(10, exp);
    var n = v / base;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * base;
  }

  function fmtCompact(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }

  function fmtMoney(v) {
    return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', {
      minimumFractionDigits: 0, maximumFractionDigits: 0
    });
  }

  /** Observe a container and re-run `draw` whenever its width changes. */
  function responsive(container, draw) {
    var lastWidth = -1;
    function run() {
      var w = container.clientWidth;
      if (w <= 0) return;
      if (Math.abs(w - lastWidth) < 2) return;
      lastWidth = w;
      draw(w);
    }
    if (container.__chartObserver) container.__chartObserver.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(run);
      ro.observe(container);
      container.__chartObserver = ro;
    } else {
      window.addEventListener('resize', run);
    }
    run();
    // Containers inside a hidden tab report width 0; catch them on reveal.
    if (container.clientWidth <= 0) requestAnimationFrame(run);
  }

  function tooltipFor(container) {
    var tip = container.querySelector('.chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.setAttribute('role', 'status');
      container.appendChild(tip);
    }
    return tip;
  }

  /* ------------------------------------------------------------------ *
   * Area / line chart
   * ------------------------------------------------------------------ *
   * opts = {
   *   series: [{ label, color, data: number[], fill: bool, dashed: bool, area: 'stack'|null }],
   *   labels: string[],            // one per x index
   *   height, yFormat, valueFormat,
   *   markers: [{ index, label, color }],
   *   stacked: bool,
   *   yMinZero: bool
   * }
   */
  function area(container, opts) {
    opts = opts || {};
    var series = (opts.series || []).filter(function (s) { return s && s.data && s.data.length; });
    if (!series.length) { container.innerHTML = ''; return; }
    var labels = opts.labels || [];
    var height = opts.height || 300;
    var fmtY = opts.yFormat || fmtCompact;
    var fmtV = opts.valueFormat || fmtMoney;
    var stacked = !!opts.stacked;
    var n = series[0].data.length;
    var tip = tooltipFor(container);

    responsive(container, function (width) {
      var padL = 62, padR = 16, padT = 16, padB = 34;
      var w = Math.max(240, width);
      var plotW = w - padL - padR;
      var plotH = height - padT - padB;

      // --- y domain ---------------------------------------------------
      var maxY = 0, minY = 0;
      if (stacked) {
        for (var i = 0; i < n; i++) {
          var sum = 0;
          for (var s = 0; s < series.length; s++) sum += series[s].data[i] || 0;
          if (sum > maxY) maxY = sum;
        }
      } else {
        for (var s2 = 0; s2 < series.length; s2++) {
          for (var j = 0; j < series[s2].data.length; j++) {
            var v = series[s2].data[j];
            if (v > maxY) maxY = v;
            if (v < minY) minY = v;
          }
        }
      }
      var top = niceCeil(maxY || 1);
      var bottom = minY < 0 ? -niceCeil(-minY) : 0;
      var span = top - bottom || 1;

      var x = function (i) { return padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
      var y = function (v) { return padT + plotH - ((v - bottom) / span) * plotH; };

      var svg = el('svg', {
        width: w, height: height, viewBox: '0 0 ' + w + ' ' + height,
        class: 'chart-svg', role: 'img',
        'aria-label': opts.ariaLabel || 'Chart'
      });

      var gid = 'cg' + (++uid);
      var defs = el('defs');
      series.forEach(function (sr, idx) {
        if (!sr.fill) return;
        var grad = el('linearGradient', { id: gid + '-' + idx, x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.appendChild(el('stop', { offset: '0%', 'stop-color': sr.color, 'stop-opacity': 0.34 }));
        grad.appendChild(el('stop', { offset: '100%', 'stop-color': sr.color, 'stop-opacity': 0.02 }));
        defs.appendChild(grad);
      });
      svg.appendChild(defs);

      // --- grid + y axis ----------------------------------------------
      var ticks = 5;
      for (var t = 0; t <= ticks; t++) {
        var val = bottom + (span * t) / ticks;
        var gy = y(val);
        svg.appendChild(el('line', {
          x1: padL, y1: gy, x2: w - padR, y2: gy,
          class: 'chart-grid' + (val === 0 && bottom < 0 ? ' chart-grid-zero' : '')
        }));
        var lbl = el('text', { x: padL - 10, y: gy + 4, class: 'chart-axis-label', 'text-anchor': 'end' });
        lbl.textContent = fmtY(val);
        svg.appendChild(lbl);
      }

      // --- x axis labels ----------------------------------------------
      var maxLabels = Math.max(2, Math.floor(plotW / 74));
      var step = Math.max(1, Math.ceil(n / maxLabels));
      for (var xi = 0; xi < n; xi += step) {
        var tx = el('text', { x: x(xi), y: height - 12, class: 'chart-axis-label', 'text-anchor': 'middle' });
        tx.textContent = labels[xi] !== undefined ? labels[xi] : xi;
        svg.appendChild(tx);
      }

      // --- series ------------------------------------------------------
      var stackTotals = new Array(n).fill(0);
      series.forEach(function (sr, idx) {
        var pts = [], basePts = [];
        for (var i = 0; i < n; i++) {
          var base = stacked ? stackTotals[i] : bottom;
          var val = stacked ? stackTotals[i] + (sr.data[i] || 0) : (sr.data[i] || 0);
          pts.push([x(i), y(val)]);
          basePts.push([x(i), y(base)]);
          if (stacked) stackTotals[i] = val;
        }
        var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ');

        if (sr.fill) {
          var back = basePts.slice().reverse()
            .map(function (p) { return 'L' + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ');
          svg.appendChild(el('path', {
            d: line + ' ' + back + ' Z',
            fill: 'url(#' + gid + '-' + idx + ')', stroke: 'none'
          }));
        }
        svg.appendChild(el('path', {
          d: line, fill: 'none', stroke: sr.color, 'stroke-width': sr.width || 2.5,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          'stroke-dasharray': sr.dashed ? '6 5' : null,
          class: 'chart-line'
        }));
      });

      // --- markers (payoff dates, break-even, PMI drop) -----------------
      (opts.markers || []).forEach(function (m) {
        if (m.index === null || m.index === undefined || m.index < 0 || m.index >= n) return;
        var mx = x(m.index);
        svg.appendChild(el('line', {
          x1: mx, y1: padT, x2: mx, y2: padT + plotH,
          stroke: m.color || 'currentColor', 'stroke-width': 1.5,
          'stroke-dasharray': '4 4', class: 'chart-marker'
        }));
        var flagAnchor = mx > padL + plotW * 0.62 ? 'end' : 'start';
        var ft = el('text', {
          x: mx + (flagAnchor === 'end' ? -7 : 7), y: padT + 12,
          class: 'chart-marker-label', 'text-anchor': flagAnchor, fill: m.color || null
        });
        ft.textContent = m.label;
        svg.appendChild(ft);
      });

      // --- hover crosshair ---------------------------------------------
      var hoverLine = el('line', {
        y1: padT, y2: padT + plotH, class: 'chart-crosshair', opacity: 0
      });
      svg.appendChild(hoverLine);
      var dots = series.map(function (sr) {
        var d = el('circle', { r: 4.5, fill: sr.color, class: 'chart-dot', opacity: 0 });
        svg.appendChild(d);
        return d;
      });

      var overlay = el('rect', {
        x: padL, y: padT, width: plotW, height: plotH,
        fill: 'transparent', class: 'chart-overlay'
      });
      svg.appendChild(overlay);

      function locate(clientX) {
        var rect = svg.getBoundingClientRect();
        var scale = rect.width / w;
        var px = (clientX - rect.left) / scale;
        var i = n <= 1 ? 0 : Math.round(((px - padL) / plotW) * (n - 1));
        return Math.max(0, Math.min(n - 1, i));
      }

      function show(i, clientX) {
        var hx = x(i);
        hoverLine.setAttribute('x1', hx);
        hoverLine.setAttribute('x2', hx);
        hoverLine.setAttribute('opacity', 1);
        var running = 0;
        series.forEach(function (sr, idx) {
          var val = stacked ? (running += (sr.data[i] || 0)) : (sr.data[i] || 0);
          dots[idx].setAttribute('cx', hx);
          dots[idx].setAttribute('cy', y(val));
          dots[idx].setAttribute('opacity', 1);
        });
        var rows = series.map(function (sr) {
          return '<div class="tip-row"><span class="tip-swatch" style="background:' + sr.color + '"></span>' +
            '<span class="tip-label">' + sr.label + '</span>' +
            '<span class="tip-value">' + fmtV(sr.data[i] || 0, i) + '</span></div>';
        }).join('');
        tip.innerHTML = '<div class="tip-title">' + (labels[i] !== undefined ? labels[i] : i) + '</div>' + rows;
        tip.classList.add('is-visible');
        var cRect = container.getBoundingClientRect();
        var sRect = svg.getBoundingClientRect();
        var scale = sRect.width / w;
        var left = sRect.left - cRect.left + hx * scale;
        var tw = tip.offsetWidth;
        left = Math.max(4, Math.min(cRect.width - tw - 4, left - tw / 2));
        tip.style.left = left + 'px';
        tip.style.top = '6px';
      }

      function hide() {
        hoverLine.setAttribute('opacity', 0);
        dots.forEach(function (d) { d.setAttribute('opacity', 0); });
        tip.classList.remove('is-visible');
      }

      overlay.addEventListener('mousemove', function (e) { show(locate(e.clientX), e.clientX); });
      overlay.addEventListener('mouseleave', hide);
      overlay.addEventListener('touchstart', function (e) {
        if (e.touches[0]) show(locate(e.touches[0].clientX), e.touches[0].clientX);
      }, { passive: true });
      overlay.addEventListener('touchmove', function (e) {
        if (e.touches[0]) show(locate(e.touches[0].clientX), e.touches[0].clientX);
      }, { passive: true });
      overlay.addEventListener('touchend', hide);

      container.querySelectorAll('svg').forEach(function (old) { old.remove(); });
      container.insertBefore(svg, container.firstChild);
    });
  }

  /* ------------------------------------------------------------------ *
   * Donut
   * ------------------------------------------------------------------ */
  function donut(container, opts) {
    opts = opts || {};
    var segments = (opts.segments || []).filter(function (s) { return s.value > 0; });
    var tip = tooltipFor(container);

    responsive(container, function (width) {
      var size = Math.max(160, Math.min(opts.size || 240, width));
      var cx = size / 2, cy = size / 2;
      var thickness = opts.thickness || Math.max(20, size * 0.16);
      var radius = size / 2 - thickness / 2 - 2;
      var total = segments.reduce(function (a, s) { return a + s.value; }, 0);

      var svg = el('svg', {
        width: size, height: size, viewBox: '0 0 ' + size + ' ' + size,
        class: 'chart-svg donut-svg', role: 'img',
        'aria-label': opts.ariaLabel || 'Payment breakdown'
      });

      if (total <= 0) {
        svg.appendChild(el('circle', {
          cx: cx, cy: cy, r: radius, fill: 'none',
          'stroke-width': thickness, class: 'donut-empty'
        }));
      } else {
        var angle = -Math.PI / 2;
        var gap = segments.length > 1 ? 0.014 : 0;
        segments.forEach(function (seg) {
          var sweep = (seg.value / total) * Math.PI * 2;
          var a0 = angle + gap / 2, a1 = angle + sweep - gap / 2;
          if (a1 <= a0) a1 = a0 + 0.001;
          var large = (a1 - a0) > Math.PI ? 1 : 0;
          var path = el('path', {
            d: 'M ' + (cx + radius * Math.cos(a0)) + ' ' + (cy + radius * Math.sin(a0)) +
               ' A ' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' +
               (cx + radius * Math.cos(a1)) + ' ' + (cy + radius * Math.sin(a1)),
            fill: 'none', stroke: seg.color, 'stroke-width': thickness,
            'stroke-linecap': 'butt', class: 'donut-seg'
          });
          path.addEventListener('mouseenter', function () {
            tip.innerHTML = '<div class="tip-row"><span class="tip-swatch" style="background:' + seg.color + '"></span>' +
              '<span class="tip-label">' + seg.label + '</span>' +
              '<span class="tip-value">' + fmtMoney(seg.value) + '</span></div>' +
              '<div class="tip-sub">' + ((seg.value / total) * 100).toFixed(1) + '% of payment</div>';
            tip.classList.add('is-visible');
            tip.style.left = '50%';
            tip.style.top = '-4px';
            tip.style.transform = 'translateX(-50%)';
            path.classList.add('is-hot');
          });
          path.addEventListener('mouseleave', function () {
            tip.classList.remove('is-visible');
            path.classList.remove('is-hot');
          });
          svg.appendChild(path);
          angle += sweep;
        });
      }

      if (opts.centerValue) {
        var v = el('text', { x: cx, y: cy + 2, class: 'donut-center-value', 'text-anchor': 'middle' });
        v.textContent = opts.centerValue;
        svg.appendChild(v);
      }
      if (opts.centerLabel) {
        var l = el('text', { x: cx, y: cy + 22, class: 'donut-center-label', 'text-anchor': 'middle' });
        l.textContent = opts.centerLabel;
        svg.appendChild(l);
      }

      container.querySelectorAll('svg').forEach(function (old) { old.remove(); });
      container.insertBefore(svg, container.firstChild);
    });
  }

  /* ------------------------------------------------------------------ *
   * Grouped / stacked bars
   * ------------------------------------------------------------------ */
  function bars(container, opts) {
    opts = opts || {};
    var series = opts.series || [];
    var labels = opts.labels || [];
    var height = opts.height || 280;
    var stacked = opts.stacked !== false;
    var fmtY = opts.yFormat || fmtCompact;
    var fmtV = opts.valueFormat || fmtMoney;
    var n = labels.length;
    if (!n || !series.length) { container.innerHTML = ''; return; }
    var tip = tooltipFor(container);

    responsive(container, function (width) {
      var padL = 62, padR = 16, padT = 14, padB = 34;
      var w = Math.max(240, width);
      var plotW = w - padL - padR;
      var plotH = height - padT - padB;

      var maxY = 0;
      for (var i = 0; i < n; i++) {
        if (stacked) {
          var sum = 0;
          for (var s = 0; s < series.length; s++) sum += series[s].data[i] || 0;
          maxY = Math.max(maxY, sum);
        } else {
          for (var s2 = 0; s2 < series.length; s2++) maxY = Math.max(maxY, series[s2].data[i] || 0);
        }
      }
      var top = niceCeil(maxY || 1);
      var y = function (v) { return padT + plotH - (v / top) * plotH; };

      var slot = plotW / n;
      var barW = Math.max(2, Math.min(slot * 0.68, stacked ? 44 : 34));

      var svg = el('svg', {
        width: w, height: height, viewBox: '0 0 ' + w + ' ' + height,
        class: 'chart-svg', role: 'img', 'aria-label': opts.ariaLabel || 'Bar chart'
      });

      for (var t = 0; t <= 4; t++) {
        var val = (top * t) / 4, gy = y(val);
        svg.appendChild(el('line', { x1: padL, y1: gy, x2: w - padR, y2: gy, class: 'chart-grid' }));
        var lbl = el('text', { x: padL - 10, y: gy + 4, class: 'chart-axis-label', 'text-anchor': 'end' });
        lbl.textContent = fmtY(val);
        svg.appendChild(lbl);
      }

      var labelStep = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 44))));

      for (var b = 0; b < n; b++) {
        var cx = padL + slot * b + slot / 2;
        var baseY = padT + plotH;

        if (stacked) {
          for (var si = 0; si < series.length; si++) {
            var v = series[si].data[b] || 0;
            if (v <= 0) continue;
            var h = (v / top) * plotH;
            svg.appendChild(el('rect', {
              x: cx - barW / 2, y: baseY - h, width: barW, height: Math.max(0.5, h),
              fill: series[si].color, class: 'chart-bar',
              rx: si === series.length - 1 ? 3 : 0
            }));
            baseY -= h;
          }
        } else {
          var gw = barW / series.length;
          for (var sj = 0; sj < series.length; sj++) {
            var vv = series[sj].data[b] || 0;
            var hh = (vv / top) * plotH;
            svg.appendChild(el('rect', {
              x: cx - barW / 2 + gw * sj, y: padT + plotH - hh,
              width: Math.max(1, gw - 1.5), height: Math.max(0.5, hh),
              fill: series[sj].color, class: 'chart-bar', rx: 2
            }));
          }
        }

        if (b % labelStep === 0) {
          var xt = el('text', { x: cx, y: height - 12, class: 'chart-axis-label', 'text-anchor': 'middle' });
          xt.textContent = labels[b];
          svg.appendChild(xt);
        }

        // Invisible full-height hit area keeps the tooltip easy to trigger.
        (function (index, centerX) {
          var hit = el('rect', {
            x: padL + slot * index, y: padT, width: slot, height: plotH,
            fill: 'transparent', class: 'chart-overlay'
          });
          hit.addEventListener('mouseenter', function () {
            var rows = series.map(function (sr) {
              return '<div class="tip-row"><span class="tip-swatch" style="background:' + sr.color + '"></span>' +
                '<span class="tip-label">' + sr.label + '</span>' +
                '<span class="tip-value">' + fmtV(sr.data[index] || 0) + '</span></div>';
            }).join('');
            tip.innerHTML = '<div class="tip-title">' + labels[index] + '</div>' + rows;
            tip.classList.add('is-visible');
            var cRect = container.getBoundingClientRect();
            var sRect = svg.getBoundingClientRect();
            var scale = sRect.width / w;
            var left = sRect.left - cRect.left + centerX * scale - tip.offsetWidth / 2;
            tip.style.transform = '';
            tip.style.left = Math.max(4, Math.min(cRect.width - tip.offsetWidth - 4, left)) + 'px';
            tip.style.top = '4px';
          });
          hit.addEventListener('mouseleave', function () { tip.classList.remove('is-visible'); });
          svg.appendChild(hit);
        })(b, cx);
      }

      container.querySelectorAll('svg').forEach(function (old) { old.remove(); });
      container.insertBefore(svg, container.firstChild);
    });
  }

  /** Simple horizontal legend rendered as HTML next to a chart. */
  function legend(container, items) {
    container.innerHTML = items.map(function (it) {
      return '<span class="legend-item"><span class="legend-swatch" style="background:' +
        it.color + (it.dashed ? ';opacity:.85' : '') + '"></span>' + it.label + '</span>';
    }).join('');
  }

  return {
    area: area, donut: donut, bars: bars, legend: legend,
    fmtCompact: fmtCompact, fmtMoney: fmtMoney
  };
});
