const rotatingWords = ['code', 'test', 'debug', 'preview', 'ship'];

function initWordRotator() {
    const target = document.getElementById('hero-rotator');
    if (!target) return;

    let index = 0;
    setInterval(() => {
        index = (index + 1) % rotatingWords.length;
        target.animate(
            [
                { opacity: 1, transform: 'translateY(0px)' },
                { opacity: 0, transform: 'translateY(12px)' }
            ],
            { duration: 220, easing: 'ease-in' }
        ).onfinish = () => {
            target.textContent = rotatingWords[index];
            target.animate(
                [
                    { opacity: 0, transform: 'translateY(-12px)' },
                    { opacity: 1, transform: 'translateY(0px)' }
                ],
                { duration: 320, easing: 'ease-out' }
            );
        };
    }, 1800);
}

function initReveal() {
    const revealElements = document.querySelectorAll('.reveal');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.18 });

    revealElements.forEach((element) => observer.observe(element));
}

function initStickyHeaderAndCta() {
    const header = document.getElementById('navbar');
    const stickyCta = document.getElementById('sticky-cta');

    const onScroll = () => {
        const y = window.scrollY;
        header.classList.toggle('scrolled', y > 12);
        stickyCta.classList.toggle('show', y > 620);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
}

function animateCounters() {
    const counters = document.querySelectorAll('[data-count]');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;

            const element = entry.target;
            const target = Number(element.dataset.count || 0);
            const duration = 1400;
            const startTime = performance.now();

            const tick = (now) => {
                const progress = Math.min((now - startTime) / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3);
                element.textContent = Math.floor(target * eased);

                if (progress < 1) {
                    requestAnimationFrame(tick);
                } else {
                    element.textContent = target;
                    if (target === 24) element.textContent = '24';
                }
            };

            requestAnimationFrame(tick);
            observer.unobserve(element);
        });
    }, { threshold: 0.55 });

    counters.forEach((counter) => observer.observe(counter));
}

function initMagneticButtons() {
    const interactive = document.querySelectorAll('.magnetic');

    interactive.forEach((element) => {
        element.addEventListener('mousemove', (event) => {
            const rect = element.getBoundingClientRect();
            const offsetX = event.clientX - rect.left - rect.width / 2;
            const offsetY = event.clientY - rect.top - rect.height / 2;
            element.style.transform = `translate(${offsetX * 0.08}px, ${offsetY * 0.08}px)`;
        });

        element.addEventListener('mouseleave', () => {
            element.style.transform = '';
        });
    });
}

function initParallax() {
    const elements = document.querySelectorAll('[data-depth]');

    window.addEventListener('mousemove', (event) => {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const offsetX = (event.clientX - centerX) / centerX;
        const offsetY = (event.clientY - centerY) / centerY;

        elements.forEach((element) => {
            const depth = Number(element.dataset.depth || 0);
            const moveX = offsetX * depth;
            const moveY = offsetY * depth;
            element.style.transform = `translate3d(${moveX}px, ${moveY}px, 0)`;
        });
    });
}

function initCommandCycler() {
    const items = Array.from(document.querySelectorAll('.command-item'));
    if (!items.length) return;

    let index = 0;
    setInterval(() => {
        items.forEach((item) => item.classList.remove('active'));
        index = (index + 1) % items.length;
        items[index].classList.add('active');
    }, 1800);
}

function initCanvasBackground() {
    const canvas = document.getElementById('live-bg');
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let width = 0;
    let height = 0;
    let animationFrame = 0;
    const pointer = { x: 0, y: 0, active: false };

    const particles = Array.from({ length: 80 }, () => ({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.0008,
        vy: (Math.random() - 0.5) * 0.0008,
        size: Math.random() * 2.2 + 0.8
    }));

    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
        context.clearRect(0, 0, width, height);

        for (let i = 0; i < particles.length; i += 1) {
            const p = particles[i];
            p.x += p.vx;
            p.y += p.vy;

            if (p.x < 0 || p.x > 1) p.vx *= -1;
            if (p.y < 0 || p.y > 1) p.vy *= -1;

            const px = p.x * width;
            const py = p.y * height;

            context.beginPath();
            context.fillStyle = 'rgba(130, 180, 255, 0.55)';
            context.arc(px, py, p.size, 0, Math.PI * 2);
            context.fill();

            for (let j = i + 1; j < particles.length; j += 1) {
                const q = particles[j];
                const qx = q.x * width;
                const qy = q.y * height;
                const dx = px - qx;
                const dy = py - qy;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 120) {
                    context.beginPath();
                    context.strokeStyle = `rgba(120, 165, 255, ${0.12 - distance / 1200})`;
                    context.lineWidth = 1;
                    context.moveTo(px, py);
                    context.lineTo(qx, qy);
                    context.stroke();
                }
            }

            if (pointer.active) {
                const dx = px - pointer.x;
                const dy = py - pointer.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 180) {
                    context.beginPath();
                    context.strokeStyle = `rgba(97, 229, 255, ${0.22 - distance / 900})`;
                    context.lineWidth = 1.2;
                    context.moveTo(px, py);
                    context.lineTo(pointer.x, pointer.y);
                    context.stroke();
                }
            }
        }

        animationFrame = requestAnimationFrame(draw);
    };

    resize();
    draw();

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', (event) => {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.active = true;
    }, { passive: true });
    window.addEventListener('mouseleave', () => {
        pointer.active = false;
    });

    window.addEventListener('beforeunload', () => cancelAnimationFrame(animationFrame));
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) {
        window.lucide.createIcons();
    }

    initWordRotator();
    initReveal();
    initStickyHeaderAndCta();
    animateCounters();
    initMagneticButtons();
    initParallax();
    initCommandCycler();
    initCanvasBackground();
});
