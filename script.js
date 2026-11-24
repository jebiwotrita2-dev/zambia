const modal = document.getElementById('modal');

document.querySelectorAll('.plan-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.plan-card').forEach(item => item.classList.remove('selected'));
    card.classList.add('selected');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    window.setTimeout(() => {
      const plan = encodeURIComponent(card.dataset.plan || '');
      const price = encodeURIComponent(card.dataset.price || '');
      window.location.href = `trial.html?plan=${plan}&price=${price}`;
    }, 3000);
  });
});

document.querySelectorAll('[data-lang]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-lang]').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
  });
});
