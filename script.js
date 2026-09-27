// script.js – entrance animation & scroll reveal for modern product landing page

document.addEventListener('DOMContentLoaded', () => {
    // Activate hero entrance animation (already defined via CSS animation on .hero-content)
    const heroContent = document.querySelector('.hero-content');
    if (heroContent) {
        // Force reflow to ensure animation runs (optional)
        heroContent.style.opacity = '1';
    }

    // Scroll reveal logic for elements with the .reveal class
    const revealElements = document.querySelectorAll('.reveal');

    const revealOnScroll = () => {
        const viewportHeight = window.innerHeight;
        revealElements.forEach(el => {
            const rect = el.getBoundingClientRect();
            // Trigger when element is within 150px of viewport bottom
            if (rect.top <= viewportHeight - 150) {
                el.classList.add('active');
            }
        });
    };

    // Initial check in case some elements are already in view
    revealOnScroll();

    // Listen for scroll and resize events
    window.addEventListener('scroll', revealOnScroll);
    window.addEventListener('resize', revealOnScroll);
});