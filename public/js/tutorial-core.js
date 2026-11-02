class TutorialSystem {
    constructor(steps) {
        this.steps = steps;
        this.currentStep = 0;
        this.isActive = false;
        this.currentAudio = null;

        // 요소 참조
        this.overlay = document.getElementById("tutorialOverlay");
        this.spotlight = document.getElementById("tutorialSpotlight");
        this.mascot = document.getElementById("tutorialMascot");
        this.mascotImg = document.getElementById("mascotImg");
        this.ttsIcon = document.getElementById("ttsIcon");
        this.bubble = document.getElementById("tutorialBubble");
        this.bubbleTitle = document.getElementById("bubbleTitle");
        this.bubbleText = document.getElementById("bubbleText");
        this.skipBtn = document.getElementById("skipBtn");
        this.nextBtn = document.getElementById("nextBtn");
        this.progress = document.getElementById("tutorialProgress");
        this.helpButton = document.getElementById("helpButton");

        this.bindEvents();
    }

    bindEvents() {
        if (this.helpButton) {
            this.helpButton.addEventListener("click", () => this.start());
        }
        if (this.skipBtn) {
            this.skipBtn.addEventListener("click", () => this.end());
        }
        if (this.nextBtn) {
            this.nextBtn.addEventListener("click", () => this.nextStep());
        }
        if (this.ttsIcon) {
            this.ttsIcon.addEventListener("click", () => {
                const step = this.steps[this.currentStep];
                if (step && step.audio) this.playAudio(step.audio);
            });
        }
    }

    start() {
        // 이미 실행 중이면 무시
        if (this.isActive) return;

        this.originalOverflow = document.body.style.overflow;

        // 스크롤 잠금
        document.body.style.overflow = "hidden";
        this.isActive = true;
        this.currentStep = 0;

        this.overlay.classList.add("active");
        this.mascot.classList.add("active");
        this.bubble.classList.add("active");

        // 🔹 클릭 차단 레이어 생성
        if (!document.getElementById("tutorialBlocker")) {
            const blocker = document.createElement("div");
            blocker.id = "tutorialBlocker";
            blocker.style.position = "fixed";
            blocker.style.top = "0";
            blocker.style.left = "0";
            blocker.style.width = "100%";
            blocker.style.height = "100%";
            blocker.style.background = "transparent";
            blocker.style.zIndex = "9998"; // spotlight(9999)보다 낮게
            blocker.style.pointerEvents = "auto";
            document.body.appendChild(blocker);
        }

        // 🔹 마우스 휠 스크롤 막기
        this._wheelBlocker = (e) => e.preventDefault();
        window.addEventListener("wheel", this._wheelBlocker, { passive: false });

        this.showStep();
    }

    end() {
        // 원래 overflow 상태 복원
        document.body.style.overflow = this.originalOverflow || "";
        this.isActive = false;

        // 모든 활성 상태 해제
        this.overlay.classList.remove("active");
        this.mascot.classList.remove("active");
        this.bubble.classList.remove("active");
        if (this.progress) {
            this.progress.classList.remove("active");
            this.progress.innerHTML = "";
        }

        // 🔹 스포트라이트도 확실히 숨기고 좌표 초기화
        if (this.spotlight) {
            this.spotlight.style.display = "none";
            this.spotlight.style.width = "0px";
            this.spotlight.style.height = "0px";
            this.spotlight.style.top = "0px";
            this.spotlight.style.left = "0px";
        }

        // 마스코트/버블 위치 초기화
        this.mascot.style.cssText = "";
        this.bubble.style.cssText = "";
        this.bubble.className = "tutorial-bubble";

        // 진행 중 오디오 정리
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        // 🔹 클릭 차단 레이어 제거
        const blocker = document.getElementById("tutorialBlocker");
        if (blocker) blocker.remove();

        // 🔹 마우스 휠 스크롤 다시 허용
        if (this._wheelBlocker) {
            window.removeEventListener("wheel", this._wheelBlocker, { passive: false });
            this._wheelBlocker = null;
        }
    }

    highlightElement(element, position = "right") {
        const rect = element.getBoundingClientRect();
        const mascotSize = window.innerWidth < 640 ? 100 : 140;
        const bubbleH = this.bubble.offsetHeight;
        const bubbleW = this.bubble.offsetWidth;
        const gap = 20;

        // 하이라이트 단계에서는 overlay를 투명 처리(딤은 spotlight의 box-shadow가 담당)
        this.overlay.style.background = "transparent";

        // ✨ 텔레포트 준비: 이동 순간에는 애니메이션 제거
        this.spotlight.classList.add("no-anim");

        // spotlight 표시 + 즉시 좌표 갱신(텔레포트)
        this.spotlight.style.display = "block";
        this.spotlight.style.top = (rect.top - 10) + "px";
        this.spotlight.style.left = (rect.left - 10) + "px";
        this.spotlight.style.width = (rect.width + 20) + "px";
        this.spotlight.style.height = (rect.height + 20) + "px";

        // 마스코트/버블 배치
        let mascotTop, mascotLeft, bubbleLeft, bubbleTop;

        if (position === "left") {
            mascotTop = rect.top + (rect.height / 2) - (mascotSize / 2);
            mascotLeft = rect.left - mascotSize - gap;
            bubbleLeft = mascotLeft - bubbleW - 15;
            bubbleTop = mascotTop + (mascotSize / 2) - (bubbleH / 2);
            this.bubble.className = "tutorial-bubble active left";

        } else if (position === "right") {
            mascotTop = rect.top + (rect.height / 2) - (mascotSize / 2);
            mascotLeft = rect.right + gap;
            bubbleLeft = mascotLeft + mascotSize + 15;
            bubbleTop = mascotTop + (mascotSize / 2) - (bubbleH / 2);
            this.bubble.className = "tutorial-bubble active right";

        } else if (position === "top") {
            mascotLeft = rect.left + (rect.width / 2) - (mascotSize / 2);
            mascotTop = rect.top - mascotSize - gap;
            bubbleLeft = mascotLeft + (mascotSize / 2) - (bubbleW / 2);
            bubbleTop = mascotTop - bubbleH - 15;
            this.bubble.className = "tutorial-bubble active top";

        } else if (position === "bottom") {
            mascotLeft = rect.left + (rect.width / 2) - (mascotSize / 2);
            mascotTop = rect.bottom + gap;
            bubbleLeft = mascotLeft + (mascotSize / 2) - (bubbleW / 2);
            bubbleTop = mascotTop + mascotSize + 15;
            this.bubble.className = "tutorial-bubble active bottom";
        }

        this.mascot.style.cssText = `left:${mascotLeft}px; top:${mascotTop}px;`;
        this.bubble.style.cssText = `left:${bubbleLeft}px; top:${bubbleTop}px;`;

        // 다음 프레임에 애니메이션을 복구(다음 이동부터는 원래 트랜지션 사용)
        requestAnimationFrame(() => {
            this.spotlight.classList.remove("no-anim");
            this.bubble.classList.add("show");
        });
    }

    nextStep() {
        this.currentStep++;
        if (this.currentStep >= this.steps.length) {
            this.end();
        } else {
            this.showStep();
        }
    }

    showStep() {
        const stepIndex = this.currentStep;
        const step = this.steps[stepIndex];

        // 진행 표시 업데이트
        const dots = this.progress ? this.progress.querySelectorAll(".progress-dot") : [];
        dots.forEach((d, i) => d.classList.toggle("active", i === stepIndex));

        // 마스코트 / 텍스트
        if (this.mascotImg && step.mascot) {
            this.mascotImg.src = `/images/${step.mascot}.png`;
        }
        this.bubbleTitle.textContent = step.title || "";
        this.bubbleText.innerHTML = (step.text || "").replace(/\n/g, "<br>");

        // 버튼 상태
        const isLast = stepIndex === this.steps.length - 1;
        this.nextBtn.textContent = isLast ? "시작하기" : "다음";
        this.nextBtn.classList.toggle("finish", isLast);
        this.skipBtn.style.display = isLast ? "none" : "inline-block";

        // 1️⃣ 스크롤 이전 위치 기록
        const prevScrollY = window.scrollY;

        // ✅ 딤 책임 전환: 스크롤 중에는 overlay가 딤을 담당(배경 유지)
        //    이전 step에서 overlay가 transparent였어도 여기서 즉시 복구
        this.overlay.style.background = "rgba(0,0,0,0.85)";

        // ✅ 스크롤 시작 전에 spotlight 완전 숨김(이전 사각형 노출 방지)
        this.hideSpotlight();

        // 2️⃣ 스크롤 먼저 수행
        this.scrollTo(step);

        // 3️⃣ 스크롤 후 처리
        setTimeout(() => {
            const newScrollY = window.scrollY;
            const target = step.target ? document.querySelector(step.target) : null;

            const runHighlight = () => {
                if (!this.isActive || this.currentStep !== stepIndex) return;

                if (isLast) {
                    // 🔹 마지막 스텝 → 중앙 안내(overlay 딤 유지)
                    this.hideSpotlight();
                    this.showCenter();
                } else {
                    // ✅ 새 위치에서 텔레포트(animate off → on은 highlightElement 내부에서 처리)
                    if (target) {
                        this.highlightElement(target, step.position || "right");
                    } else {
                        this.showCenter();
                    }
                    // 필요 시 명시적 표시(중복 무해)
                    this.showSpotlight();
                }
            };

            if (newScrollY === prevScrollY) {
                runHighlight();
                return;
            }

            const onScrollEnd = () => {
                clearTimeout(this._scrollTimer);
                this._scrollTimer = setTimeout(() => {
                    runHighlight();
                    window.removeEventListener("scroll", onScrollEnd);
                }, 120);
            };

            window.addEventListener("scroll", onScrollEnd);
        }, 50);
    }

    hideSpotlight() {
        if (this.spotlight) {
            this.spotlight.style.display = "none";
        }
    }

    showSpotlight() {
        if (this.spotlight) {
            this.spotlight.style.display = "block";
        }
    }

    createProgressDots() {
        if (!this.progress) return;
        this.progress.innerHTML = "";
        for (let i = 0; i < this.steps.length; i++) {
            const dot = document.createElement("div");
            dot.className = "progress-dot";
            this.progress.appendChild(dot);
        }
    }

    showCenter() {
        this.overlay.style.background = "rgba(0,0,0,0.85)";
        const mascotSize = window.innerWidth < 640 ? 100 : 140;
        const bubbleW = this.bubble.offsetWidth;
        const gap = 30;
        const total = mascotSize + bubbleW + gap;
        const mascotLeft = (window.innerWidth / 2) - (total / 2);
        const bubbleLeft = mascotLeft + mascotSize + gap;

        this.spotlight.style.display = "none";
        this.mascot.style.cssText = `left:${mascotLeft}px; top:50%; transform:translateY(-50%);`;
        this.bubble.style.cssText = `left:${bubbleLeft}px; top:calc(50% - 30px); transform:translateY(-50%);`;
        this.bubble.className = "tutorial-bubble active right";

        requestAnimationFrame(() => this.bubble.classList.add("show"));
    }

    playAudio(src) {
        if (this.currentAudio) this.currentAudio.pause();
        this.currentAudio = new Audio(src);
        this.currentAudio.play().catch(() => { });
    }

    scrollTo(step) {
        if (!step.scroll) return;
        if (step.scroll.mode === "percent") {
            const y = window.innerHeight * step.scroll.percent + (step.scroll.offsetPx || 0);
            window.scrollTo({ top: y, behavior: "smooth" });
        } else if (step.scroll.mode === "pixel") {
            window.scrollTo({ top: step.scroll.offsetPx || 0, behavior: "smooth" });
        }
    }
}

