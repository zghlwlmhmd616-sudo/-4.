(() => {
  const button = document.querySelector('#aiOpen');
  const panel = document.querySelector('#assistantWindow');
  const close = document.querySelector('#assistantClose');
  const messages = document.querySelector('#assistantMessages');
  const form = document.querySelector('#assistantForm');
  const input = document.querySelector('#assistantInput');
  const sendButton = form.querySelector('button');
  const history = [];

  function remember(role, content) {
    history.push({ role, content });
    if (history.length > 12) history.splice(0, history.length - 12);
  }

  function addMessage(text, role) {
    const message = document.createElement('div');
    message.className = `message${role === 'user' ? ' mine' : ''}`;
    message.textContent = text;
    messages.append(message);
    messages.scrollTop = messages.scrollHeight;
  }

  function setBusy(busy) {
    input.disabled = busy;
    sendButton.disabled = busy;
    sendButton.textContent = busy ? 'جارٍ الرد…' : 'إرسال';
  }

  button.onclick = () => {
    document.querySelector('#chatWindow').classList.remove('open');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      if (!messages.childElementCount) {
        addMessage('أهلًا بكِ! أنا مساعد سجدة. اسأليني عن الموديلات والأسعار والعروض.', 'assistant');
      }
      input.focus();
    }
  };

  document.querySelector('#chatOpen').addEventListener('click', () => panel.classList.remove('open'));
  close.onclick = () => panel.classList.remove('open');

  form.onsubmit = async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || sendButton.disabled) return;
    if (!window.sajdaBackend?.configured) {
      addMessage('المساعد غير متصل حاليًا. يمكنكِ مراسلة خدمة العملاء عبر واتساب 01200696273.', 'assistant');
      return;
    }

    addMessage(text, 'user');
    remember('user', text);
    input.value = '';
    setBusy(true);
    try {
      const reply = await window.sajdaBackend.assistantReply(history.slice(-12));
      remember('assistant', reply);
      addMessage(reply, 'assistant');
    } catch (error) {
      console.error('تعذر الحصول على رد من مساعد سجدة', error);
      addMessage('تعذر الحصول على رد الآن. حاولي لاحقًا أو تواصلي معنا عبر واتساب 01200696273.', 'assistant');
    } finally {
      setBusy(false);
      input.focus();
    }
  };
})();
