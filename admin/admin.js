/**
 * UpPlay Admin Dashboard — Interatividade, Gráfico em Canvas e Telemetria em Tempo Real
 */
(function() {
  'use strict';

  let currentPeriod = 'today';
  let activeVisitorsInterval = null;
  let metricsInterval = null;
  let cachedMetrics = null;

  // 1. Inicialização e Verificação de Sessão
  document.addEventListener('DOMContentLoaded', async () => {
    const isAuthed = await checkAuth();
    if (!isAuthed) return;

    setupNavigation();
    setupFilters();
    setupLogout();

    // Carga inicial
    loadDashboardData();

    // Polling contínuo dos visitantes ativos (a cada 5 segundos)
    activeVisitorsInterval = setInterval(fetchActiveVisitors, 5000);

    // Atualização das métricas consolidadas a cada 30 segundos
    metricsInterval = setInterval(loadDashboardData, 30000);

    // Redimensionamento responsivo do gráfico em Canvas
    window.addEventListener('resize', debounce(() => {
      if (cachedMetrics && cachedMetrics.timeline) {
        renderCanvasChart(cachedMetrics.timeline);
      }
    }, 200));
  });

  // 2. Verificação de Autenticação com o Servidor
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        window.location.href = '/admin/login';
        return false;
      }
      const data = await res.json();
      if (!data.authenticated) {
        window.location.href = '/admin/login';
        return false;
      }

      const userEl = document.getElementById('currentAdminUser');
      if (userEl && data.username) {
        userEl.textContent = data.username;
      }
      return true;
    } catch {
      window.location.href = '/admin/login';
      return false;
    }
  }

  // 3. Logout
  function setupLogout() {
    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } finally {
          window.location.href = '/admin/login';
        }
      });
    }
  }

  // 4. Configuração dos Filtros de Período
  function setupFilters() {
    const buttons = document.querySelectorAll('.btn-period');
    const customRangeBox = document.getElementById('customDateRange');
    const btnApplyCustom = document.getElementById('btnApplyCustom');
    const inputStart = document.getElementById('inputStartDate');
    const inputEnd = document.getElementById('inputEndDate');

    // Inicializa datas customizadas com o dia de hoje
    const todayStr = new Date().toISOString().split('T')[0];
    if (inputStart && inputEnd) {
      inputStart.value = todayStr;
      inputEnd.value = todayStr;
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const period = btn.getAttribute('data-period');
        currentPeriod = period;

        if (period === 'custom') {
          customRangeBox.classList.add('is-active');
        } else {
          customRangeBox.classList.remove('is-active');
          loadDashboardData();
        }
      });
    });

    if (btnApplyCustom) {
      btnApplyCustom.addEventListener('click', () => {
        if (!inputStart.value || !inputEnd.value) {
          alert('Por favor, selecione data inicial e data final.');
          return;
        }
        loadDashboardData();
      });
    }
  }

  // 5. Consulta e Atualização dos Visitantes Ativos Agora (<60s)
  async function fetchActiveVisitors() {
    try {
      const res = await fetch('/api/admin/active-visitors');
      if (!res.ok) return;
      const data = await res.json();
      const el = document.getElementById('kpiActiveNow');
      if (el) {
        el.textContent = data.active_now || 0;
      }
    } catch {}
  }

  // 6. Carregamento de Métricas Consolidadas
  async function loadDashboardData() {
    let url = `/api/admin/metrics?period=${encodeURIComponent(currentPeriod)}`;
    if (currentPeriod === 'custom') {
      const start = document.getElementById('inputStartDate')?.value;
      const end = document.getElementById('inputEndDate')?.value;
      if (start && end) {
        url += `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
      }
    }

    try {
      const [metricsRes, eventsRes] = await Promise.all([
        fetch(url),
        fetch('/api/admin/events?limit=25')
      ]);

      if (metricsRes.ok) {
        const metrics = await metricsRes.json();
        cachedMetrics = metrics;
        renderKpis(metrics);
        renderCanvasChart(metrics.timeline || []);
        renderButtonBreakdown(metrics.button_locations || []);
        renderDeviceBreakdown(metrics.devices || []);
        renderReferrers(metrics.referrers || []);
        renderUtms(metrics.utms || []);
      }

      if (eventsRes.ok) {
        const eventsData = await eventsRes.json();
        renderRecentEvents(eventsData.events || []);
      }
    } catch (err) {
      console.error('[Dashboard Error]:', err);
    }
  }

  // 7. Renderização dos 5 Cards de KPI do Topo
  function renderKpis(m) {
    setText('kpiActiveNow', m.active_now ?? 0);
    setText('kpiUniqueVisitors', m.unique_visitors ?? 0);
    setText('kpiTotalPageviews', m.total_pageviews ?? 0);
    setText('kpiTotalSessions', m.total_sessions ?? 0);
    setText('kpiTotalClicks', m.total_clicks ?? 0);
    setText('kpiUniqueClickers', m.unique_clickers ?? 0);
    setText('kpiTotalDownloads', m.total_download_requests ?? 0);
    setText('kpiUniqueRequesters', m.unique_requesters ?? 0);
    setText('kpiClickRate', (m.click_rate ?? '0.0') + '%');
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // 8. Gráfico Temporal Nativo em HTML5 Canvas (Zero dependências)
  function renderCanvasChart(timeline) {
    const canvas = document.getElementById('timelineChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // Limpa tela
    ctx.clearRect(0, 0, w, h);

    if (!timeline || timeline.length === 0) {
      drawEmptyState(ctx, w, h, 'Ainda não há dados suficientes para o período selecionado');
      return;
    }

    // Calcula valor máximo para escala vertical
    let maxVal = 5;
    timeline.forEach(p => {
      if (p.views > maxVal) maxVal = p.views;
      if (p.clicks > maxVal) maxVal = p.clicks;
      if (p.downloads > maxVal) maxVal = p.downloads;
    });
    maxVal = Math.ceil(maxVal * 1.15); // margem superior

    const padding = { top: 20, right: 24, bottom: 34, left: 40 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Linhas de Grade Horizontais e Rótulos Y
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6f7887';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const y = padding.top + (chartH / ySteps) * i;
      const val = Math.round(maxVal - (maxVal / ySteps) * i);
      
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      ctx.fillText(String(val), padding.left - 8, y);
    }

    const stepX = chartW / Math.max(1, timeline.length - 1);

    // Função auxiliar de desenho de linha e área
    function drawSeries(key, strokeColor, fillColor) {
      ctx.beginPath();
      const points = [];
      timeline.forEach((pt, idx) => {
        const x = padding.left + idx * stepX;
        const val = pt[key] || 0;
        const y = padding.top + chartH - (val / maxVal) * chartH;
        points.push({ x, y });
        if (idx === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      // Linha
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Preenchimento com gradiente suave
      if (fillColor && points.length > 0) {
        ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
        ctx.lineTo(points[0].x, padding.top + chartH);
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
      }

      // Pontos destacados
      points.forEach(p => {
        ctx.fillStyle = strokeColor;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Desenha séries na ordem: Visualizações (Azul), Cliques (Âmbar), Downloads (Vermelho)
    drawSeries('views', '#38bdf8', 'rgba(56, 189, 248, 0.08)');
    drawSeries('clicks', '#f59e0b', 'rgba(245, 158, 11, 0.08)');
    drawSeries('downloads', '#e50914', 'rgba(229, 9, 20, 0.12)');

    // Rótulos X (Amostragem para evitar sobreposição)
    ctx.fillStyle = '#6f7887';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const labelFreq = Math.ceil(timeline.length / 8);
    timeline.forEach((pt, idx) => {
      if (idx % labelFreq === 0 || idx === timeline.length - 1) {
        const x = padding.left + idx * stepX;
        ctx.fillText(pt.label, x, h - padding.bottom + 10);
      }
    });
  }

  function drawEmptyState(ctx, w, h, text) {
    ctx.fillStyle = '#6f7887';
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  }

  // 9. Tabela de Desempenho por Botão de Download
  function renderButtonBreakdown(locations) {
    const tbody = document.getElementById('tbodyButtonLocations');
    if (!tbody) return;

    if (!locations || locations.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhum clique em botão registrado no período.</td></tr>';
      return;
    }

    const locationLabels = {
      header: { name: 'Cabeçalho', cls: 'btn-pos-header' },
      hero: { name: 'Primeira dobra (Hero)', cls: 'btn-pos-hero' },
      install: { name: 'Seção de Instalação', cls: 'btn-pos-install' },
      footer: { name: 'Rodapé', cls: 'btn-pos-footer' }
    };

    const totalClicks = locations.reduce((acc, curr) => acc + curr.count, 0);

    let html = '';
    locations.forEach(row => {
      const meta = locationLabels[row.button_location] || { name: row.button_location, cls: 'badge-btn-pos' };
      const share = totalClicks > 0 ? ((row.count / totalClicks) * 100).toFixed(1) : '0.0';

      html += `
        <tr>
          <td><span class="badge-btn-pos ${meta.cls}">${meta.name}</span></td>
          <td><strong>${row.count}</strong></td>
          <td>${row.unique_users}</td>
          <td>${share}%</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  // 10. Distribuição por Dispositivo
  function renderDeviceBreakdown(devices) {
    const container = document.getElementById('deviceContainer');
    if (!container) return;

    if (!devices || devices.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhum dispositivo registrado no período.</div>';
      return;
    }

    const deviceMap = {
      mobile: { label: 'Celular (Smartphones)', fillCls: 'fill-mobile' },
      desktop: { label: 'Computador (Desktop/Notebook)', fillCls: 'fill-desktop' },
      tablet: { label: 'Tablet / TV Box Android', fillCls: 'fill-tablet' }
    };

    const total = devices.reduce((acc, curr) => acc + curr.count, 0);

    let html = '';
    devices.forEach(d => {
      const meta = deviceMap[d.device_type] || { label: d.device_type, fillCls: 'fill-desktop' };
      const pct = total > 0 ? ((d.count / total) * 100).toFixed(1) : '0.0';

      html += `
        <div class="device-item">
          <div class="device-label-row">
            <span class="device-label">${meta.label}</span>
            <span class="device-count">${d.count} (${pct}%)</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${meta.fillCls}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // 11. Origens de Referência
  function renderReferrers(refs) {
    const tbody = document.getElementById('tbodyReferrers');
    if (!tbody) return;

    if (!refs || refs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty-state">Sem dados de referência no período.</td></tr>';
      return;
    }

    let html = '';
    refs.forEach(r => {
      html += `
        <tr>
          <td><strong>${escapeHtml(r.domain)}</strong></td>
          <td>${r.count} visualizações</td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  }

  // 12. Campanhas UTM
  function renderUtms(utms) {
    const tbody = document.getElementById('tbodyUtms');
    if (!tbody) return;

    if (!utms || utms.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Nenhum parâmetro UTM capturado no período.</td></tr>';
      return;
    }

    let html = '';
    utms.forEach(u => {
      html += `
        <tr>
          <td>${escapeHtml(u.source)} / ${escapeHtml(u.medium)}</td>
          <td><span class="badge-btn-pos">${escapeHtml(u.campaign)}</span></td>
          <td>${u.count}</td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  }

  // 13. Tabela de Auditoria de Eventos Recentes
  function renderRecentEvents(events) {
    const tbody = document.getElementById('tbodyRecentEvents');
    if (!tbody) return;

    if (!events || events.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Ainda não há eventos registrados no banco de dados.</td></tr>';
      return;
    }

    const typeBadges = {
      pageview: { label: 'Visualização', cls: 'evt-pageview' },
      click_download: { label: 'Clique Baixar', cls: 'evt-click' },
      download_request: { label: 'Solicitação Download', cls: 'evt-download' }
    };

    let html = '';
    events.forEach(ev => {
      const meta = typeBadges[ev.event_type] || { label: ev.event_type, cls: 'evt-pageview' };
      const dateStr = formatDateTime(ev.created_at);

      html += `
        <tr>
          <td style="font-family: monospace; font-size: 0.8125rem;">${dateStr}</td>
          <td><span class="tag-event-type ${meta.cls}">${meta.label}</span></td>
          <td style="color: var(--text-secondary);">${escapeHtml(ev.page_path || '/')}</td>
          <td>${ev.button_location ? `<span class="badge-btn-pos">${ev.button_location}</span>` : '—'}</td>
          <td>${ev.device_type || 'desktop'}</td>
          <td style="font-family: monospace; color: var(--text-muted);">${escapeHtml(ev.ip_display || 'Anônimo')}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  // 14. Utilitários Gerais
  function formatDateTime(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      const day = String(d.getDate()).padStart(2, '0');
      const mon = String(d.getMonth() + 1).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      return `${day}/${mon} ${h}:${m}:${s}`;
    } catch {
      return isoString;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function debounce(fn, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function setupNavigation() {}

})();
