(function(){
  var f=document.getElementById('contact-form'), n=document.getElementById('c-note'), b=document.getElementById('c-send');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var email=document.getElementById('c-email').value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)){
      n.textContent='Enter a valid email address so we can reply.'; n.style.color='#a32b43'; return;
    }
    b.disabled=true; b.textContent='Sendingâ€¦';
    setTimeout(function(){
      b.disabled=false; b.textContent='Send message';
      f.reset();
      n.textContent='Thanks â€” we have your message and will reply within one business day.';
      n.style.color='#226a45';
    },700);
  });
})();
