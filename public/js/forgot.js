(function(){
  var f=document.getElementById('form'),a=document.getElementById('alert'),t=document.getElementById('alert-text'),
      s=document.getElementById('submit'),e=document.getElementById('email');
  function say(m,k){t.textContent=m;a.className='alert on alert-'+(k||'error');}
  f.addEventListener('submit',function(ev){
    ev.preventDefault();
    if(!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e.value.trim())){say('Enter a valid email address.');return;}
    s.disabled=true;s.textContent='Sendingâ€¦';
    fetch('/api/password/forgot',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e.value.trim()})})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,data:d};});})
      .then(function(res){
        s.disabled=false;s.textContent='Send reset link';
        if(!res.ok){say(res.data.error||'Could not send the link.');return;}
        var msg='If that address has an account, a reset link is on its way. The link is valid for 60 minutes.';
        if(res.data.devLink){msg+=' Development mode: '+res.data.devLink;}
        say(msg,'ok');
      })
      .catch(function(){s.disabled=false;s.textContent='Send reset link';say('Network error. Try again.');});
  });
})();
