"use strict";
(() => {
  let projects = [];
  function render() {
    const language = document.documentElement.lang === 'fa' ? 'fa' : 'en';
    for (const rail of ['start','end']) document.getElementById(`promos-${rail}`).replaceChildren();
    for (const project of projects) {
      const url = new URL(project.url);
      if (url.protocol !== 'https:') continue;
      url.searchParams.set('utm_source','dari');
      url.searchParams.set('utm_medium','owned_banner');
      url.searchParams.set('utm_campaign','gryffin_projects');
      const link = document.createElement('a');
      link.className = 'project-promo'; link.href = url.href;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.src = project.image; image.alt = project.title[language];
      image.width = 640; image.height = 360; image.loading = 'lazy'; image.decoding = 'async';
      const body = document.createElement('div'); body.className = 'promo-copy';
      const label = document.createElement('small'); label.textContent = I18N.t('promotion');
      const title = document.createElement('h3'); title.textContent = project.title[language];
      const description = document.createElement('p'); description.textContent = project.description[language];
      const action = document.createElement('span'); action.className = 'promo-action'; action.textContent = I18N.t('visit_project');
      body.append(title,description,label,action); link.append(image,body);
      document.getElementById(`promos-${project.rail === 'start' ? 'start' : 'end'}`).append(link);
    }
  }
  fetch('/promos.json').then(response => {
    if (!response.ok) throw new Error('Promotions unavailable');
    return response.json();
  }).then(data => { projects=data; render(); }).catch(() => {
    document.querySelectorAll('.promo-rail').forEach(rail => {rail.hidden=true;});
    document.querySelector('.promo-layout').classList.add('no-promos');
  });
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
})();
