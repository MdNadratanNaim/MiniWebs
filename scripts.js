// Staggered card entrance via IntersectionObserver
const cards = document.querySelectorAll('.tool-card');
const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      const card = entry.target;
      const idx = Array.from(cards).indexOf(card);
      card.style.animationDelay = (0.55 + idx * 0.1) + 's';
      card.classList.add('visible');
      io.unobserve(card);
    }
  });
}, { threshold: 0.1 });
cards.forEach(card => io.observe(card));
