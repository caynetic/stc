(() => {
    "use strict";

    const lightbox = document.getElementById('lightbox');
    const lightboxImage = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImage) return;

    function openLightbox(source, description) {
        lightboxImage.src = source;
        if (description) lightboxImage.alt = description;
        lightbox.classList.add('active');
        lightbox.setAttribute('aria-hidden', 'false');
    }

    function closeLightbox() {
        lightbox.classList.remove('active');
        lightbox.setAttribute('aria-hidden', 'true');
        lightboxImage.removeAttribute('src');
    }

    // The Flask templates used onclick attributes for these actions. External
    // listeners retain the lightbox while allowing a strict script-src CSP.
    document.querySelectorAll('.entity-gallery .gallery-item img, [data-lightbox-image]').forEach(image => {
        image.addEventListener('click', () => openLightbox(image.currentSrc || image.src, image.alt));
    });

    lightbox.addEventListener('click', event => {
        if (event.target === lightbox || event.target === lightboxImage) closeLightbox();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && lightbox.classList.contains('active')) closeLightbox();
    });
})();
