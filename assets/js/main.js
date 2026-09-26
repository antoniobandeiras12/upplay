document.addEventListener('DOMContentLoaded', () => {
  // 1. Controles dos Trilhos Horizontais no Desktop
  const railControlButtons = document.querySelectorAll('[data-rail-target]');
  railControlButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-rail-target');
      const direction = btn.getAttribute('data-rail-direction');
      const rail = document.querySelector(targetId);
      if (rail) {
        const scrollDistance = direction === 'next' ? 380 : -380;
        rail.scrollBy({ left: scrollDistance, behavior: 'smooth' });
      }
    });
  });

  // 2. Expansão Real e Funcional do Catálogo Completo
  const expandBtn = document.getElementById('btn-expand-catalog');
  const extraItems = document.getElementById('extra-catalog-content');
  if (expandBtn && extraItems) {
    expandBtn.addEventListener('click', () => {
      const isCurrentlyOpen = extraItems.classList.contains('is-open');
      if (isCurrentlyOpen) {
        extraItems.classList.remove('is-open');
        expandBtn.classList.remove('is-expanded');
        expandBtn.querySelector('.btn-label').textContent = 'Ver catálogo completo';
      } else {
        extraItems.classList.add('is-open');
        expandBtn.classList.add('is-expanded');
        expandBtn.querySelector('.btn-label').textContent = 'Recolher catálogo';
      }
    });
  }

  // 3. Rolagem Suave para Âncoras
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId && targetId !== '#') {
        const targetElement = document.querySelector(targetId);
        if (targetElement) {
          e.preventDefault();
          targetElement.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
        }
      }
    });
  });

  // 4. Acordeão de Perguntas Frequentes (FAQ)
  const faqEntries = document.querySelectorAll('.faq-entry');
  faqEntries.forEach(entry => {
    entry.addEventListener('toggle', () => {
      if (entry.open) {
        faqEntries.forEach(other => {
          if (other !== entry && other.open) {
            other.open = false;
          }
        });
      }
    });
  });
});
