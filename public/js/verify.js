(function(){
  var title=document.getElementById('title'),body=document.getElementById('body-text'),
      actions=document.getElementById('actions'),token=new URLSearchParams(location.search).get('token');
  function done(head,text,links){
    title.textContent=head;body.textContent=text;
    actions.style.display='flex';
    actions.innerHTML=links.map(function(l){return '<a class="btn '+l.cls+'" href="'+l.href+'">'+l.text+'</a>';}).join('');
  }
  if(!token){done('Link is incomplete','This confirmation link is missing its token. Request a new one from your dashboard.',[{text:'Go to dashboard',href:'/dashboard.html',cls:'btn-primary'}]);return;}
  fetch('/api/verify',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:token})})
    .then(function(r){return r.json().then(function(d){return {ok:r.ok,data:d};});})
    .then(function(res){
      if(res.ok) done('Email confirmed','Your address is verified. Everything on your account is now active.',[
        {text:'Go to dashboard',href:'/dashboard.html',cls:'btn-primary'},
        {text:'Home',href:'/',cls:'btn-ghost'}]);
      else done('That link did not work',res.data.error||'The confirmation link is invalid or has expired.',[
        {text:'Request a new link',href:'/dashboard.html',cls:'btn-primary'}]);
    })
    .catch(function(){done('Network error','We could not reach the server. Check your connection and try again.',[{text:'Back',href:'/',cls:'btn-ghost'}]);});
})();
