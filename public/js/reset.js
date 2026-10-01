(function(){
  var token=new URLSearchParams(location.search).get('token');
  var f=document.getElementById('form'),a=document.getElementById('alert'),t=document.getElementById('alert-text'),
      s=document.getElementById('submit'),p=document.getElementById('pw'),c=document.getElementById('confirm');
  function say(m,k){t.textContent=m;a.className='alert on alert-'+(k||'error');}
  if(!token){
    say('This link is missing its token. Request a new one.');
    f.querySelectorAll('input,button').forEach(function(x){x.disabled=true;});
    return;
  }
  f.addEventListener('submit',function(ev){
    ev.preventDefault();
    if(p.value.length<10){say('Password must be at least 10 characters.');return;}
    if(!/[a-zA-Z]/.test(p.value)||!/\d/.test(p.value)||!/[^\w\s]/.test(p.value)){say('Mix letters with at least one number and one symbol.');return;}
    if(p.value!==c.value){say('Passwords do not match.');return;}
    s.disabled=true;s.textContent='Updatingâ€¦';
    fetch('/api/password/reset',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,newPassword:p.value})})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,data:d};});})
      .then(function(res){
        if(!res.ok){say(res.data.error||'Could not reset the password.');s.disabled=false;s.textContent='Update password';return;}
        say('Password updated. You can now sign in.','ok');
        setTimeout(function(){location.href='/login.html';},900);
      })
      .catch(function(){s.disabled=false;s.textContent='Update password';say('Network error. Try again.');});
  });
})();
