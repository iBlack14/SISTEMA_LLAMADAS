const form = document.getElementById("loginForm");
const button = document.getElementById("loginButton");
const error = document.getElementById("loginError");
form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value, password: form.password.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo iniciar sesión.");
    form.password.value = "";
    if (typeof BroadcastChannel === "function") {
      const channel = new BroadcastChannel("calls-account");
      channel.postMessage("changed");
      channel.close();
    }
    window.location.replace(data.redirect);
  } catch (failure) {
    error.textContent = failure.message || "No se pudo conectar. Intenta de nuevo.";
    button.disabled = false;
  }
});
