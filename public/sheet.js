// Consent page: send the decision with fetch (so the redirect to the app is not blocked by the
// page's form-action policy), then go where the server says.
const box = document.getElementById('consent');
if (box) {
  for (const b of box.querySelectorAll('button[data-decision]')) {
    b.addEventListener('click', async () => {
      for (const x of box.querySelectorAll('button')) x.disabled = true;
      try {
        const r = await fetch('/oauth/decision', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': box.dataset.csrf },
          body: JSON.stringify({ ask: box.dataset.ask, allow: b.dataset.decision === 'allow' }),
        });
        const j = await r.json();
        if (!r.ok || !j.redirect) throw new Error(j.error || 'Something went wrong');
        location.href = j.redirect;
      } catch (e) {
        document.getElementById('err').textContent = e.message;
        for (const x of box.querySelectorAll('button')) x.disabled = false;
      }
    });
  }
}
