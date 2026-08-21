(() => {
    "use strict";

    // Mobile menu toggle
    const hamburger = document.querySelector('.hamburger');
    const mobileMenu = document.querySelector('.mobile-menu');

    function closeMobileMenu() {
        if (!hamburger || !mobileMenu) return;
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        mobileMenu.classList.remove('open');
    }

    if (hamburger && mobileMenu) {
        hamburger.addEventListener('click', () => {
            const isOpen = hamburger.classList.toggle('open');
            hamburger.setAttribute('aria-expanded', String(isOpen));
            mobileMenu.classList.toggle('open', isOpen);
        });

        // Close menu when clicking a link
        mobileMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', closeMobileMenu);
        });

        // Close menu when clicking outside
        document.addEventListener('click', event => {
            if (!hamburger.contains(event.target) && !mobileMenu.contains(event.target)) {
                closeMobileMenu();
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeMobileMenu();
        });
    }

    // Replace the legacy inline close handlers with CSP-safe listeners.
    document.querySelectorAll('.close-btn').forEach(button => {
        button.addEventListener('click', () => {
            const message = button.closest('.alert, .contact-message');
            if (message) message.hidden = true;
        });
    });

    // Auto-hide flash messages after 5 seconds. The Web Animations API avoids
    // injecting a style element, which a strict CSP correctly blocks.
    const flashMessages = document.querySelectorAll('.contact-message, .flash-messages .alert');
    if (flashMessages.length > 0) {
        window.setTimeout(() => {
            flashMessages.forEach(message => {
                if (typeof message.animate !== 'function') {
                    message.hidden = true;
                    return;
                }
                const animation = message.animate([
                    { opacity: 1, transform: 'translateY(0)' },
                    { opacity: 0, transform: 'translateY(-10px)' }
                ], { duration: 300, easing: 'ease', fill: 'forwards' });
                animation.finished.then(() => {
                    message.hidden = true;
                }).catch(() => {
                    message.hidden = true;
                });
            });
        }, 5000);
    }

    // The Flask list templates submitted filter selects with inline onchange.
    // Keep the same behavior without requiring unsafe-inline in script-src.
    document.querySelectorAll('.search-form select, [data-auto-submit]').forEach(select => {
        select.addEventListener('change', () => {
            const form = select.closest('form');
            if (!form) return;
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();
        });
    });

    // Organization favorites were previously implemented in an inline script.
    const favoriteButtons = document.querySelectorAll('.favorite-btn');
    if (favoriteButtons.length > 0) {
        let favorites = [];
        try {
            const saved = JSON.parse(localStorage.getItem('stc_favorites') || '[]');
            if (Array.isArray(saved)) favorites = saved.filter(value => typeof value === 'string');
        } catch (_error) {
            favorites = [];
        }

        favoriteButtons.forEach(button => {
            const organizationCard = button.closest('.org-card');
            const heading = organizationCard && organizationCard.querySelector('h3');
            const organizationName = button.dataset.organizationName || (heading && heading.textContent || '').trim();
            if (!organizationName) return;

            const isFavorite = favorites.includes(organizationName);
            button.classList.toggle('favorited', isFavorite);
            button.setAttribute('aria-pressed', String(isFavorite));

            button.addEventListener('click', () => {
                const wasFavorite = button.classList.contains('favorited');
                button.classList.toggle('favorited', !wasFavorite);
                button.setAttribute('aria-pressed', String(!wasFavorite));

                if (wasFavorite) {
                    button.classList.add('breaking');
                    window.setTimeout(() => button.classList.remove('breaking'), 600);
                    favorites = favorites.filter(value => value !== organizationName);
                } else if (!favorites.includes(organizationName)) {
                    favorites.push(organizationName);
                }

                try {
                    localStorage.setItem('stc_favorites', JSON.stringify(favorites));
                } catch (_error) {
                    // Favoriting still works for this page when storage is unavailable.
                }
            });
        });
    }

    // Scroll reveal animation
    function handleScrollReveal() {
        const revealElements = document.querySelectorAll('.feature-card, .hero, .newsletter, .footer-section');

        revealElements.forEach(element => {
            element.classList.add('scroll-reveal');
        });

        if (!('IntersectionObserver' in window)) {
            revealElements.forEach(element => element.classList.add('active'));
            return;
        }

        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('active');
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px'
        });

        revealElements.forEach(element => {
            observer.observe(element);
        });
    }

    // Initialize scroll reveal on load
    if (document.readyState === 'complete') handleScrollReveal();
    else window.addEventListener('load', handleScrollReveal, { once: true });
})();
