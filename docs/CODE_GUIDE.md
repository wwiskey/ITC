# 소스 코드 안내

[프로젝트 소개](../README.md) · [소스 폴더 열기](../src/) · [재사용·재구축 가이드](RECOVERY_GUIDE.md)

프로젝트 소개와 시연 영상은 최상위 README에, 애플리케이션 코드는 `src/`에 모았습니다. 기존 외부 리소스는 삭제되어 전체 서비스는 현재 실행할 수 없습니다.

## 폴더 구조

```text
.
├── README.md                    # 프로젝트 소개 · 시연 영상 · 담당 역할
├── docs/                        # 코드 안내 · 재구축 · 배포 문서 · 캡처
└── src/
    ├── server.js                # 웹 서버 · 인증 · API 통합
    ├── package.json             # Node 의존성 · 실행 명령
    ├── .env.example             # 외부 서비스 설정 예시
    ├── public/
    │   ├── index.html           # 홈 · 온보딩
    │   ├── realtime.html        # 실시간 모의투자
    │   ├── historical.html      # 과거 시나리오 선택
    │   ├── scenarios/           # 시나리오별 학습 화면
    │   ├── crypto.html          # 암호화폐 백과사전
    │   ├── news.html            # 뉴스 탐색
    │   ├── report.html          # 개인 투자 리포트
    │   ├── mypage.html          # 사용자 정보 · 자산
    │   ├── qna.html             # 질문과 답변
    │   ├── js/                  # 브라우저 코드와 서버 등록 모듈
    │   └── css/ · images/ · voice/
    ├── services/                # DB · 인증 · 이메일 · 자산 서비스
    ├── trading/                 # 주문 처리 · 매칭 · WebSocket
    ├── azure_function_app.py    # 뉴스 수집 · 감정 분석 · 적재
    ├── config.js                # 별도 Key Vault 연동 모듈
    ├── Dockerfile               # 웹 서버 컨테이너
    ├── k8s/                     # Kubernetes 매니페스트
    ├── skaffold.yaml            # 개발용 컨테이너 배포 예시
    └── azure-pipelines.yml      # Azure DevOps 배포 예시
```

## 어디서 읽으면 되나요?

| 확인할 내용 | 진입점 |
| :--- | :--- |
| 서버·인증·API 연결 | [`src/server.js`](../src/server.js) |
| 데이터와 트랜잭션 | [`src/services/database.js`](../src/services/database.js) |
| 주문 처리·매칭 | [`src/trading/services/`](../src/trading/services/) |
| 실시간 시세·호가 연결 | [`src/trading/managers/`](../src/trading/managers/) |
| 웹 화면 | [`src/public/`](../src/public/) |
| 뉴스 수집·AI 감정 분류 | [`src/azure_function_app.py`](../src/azure_function_app.py) |

`src/public/js/`에는 브라우저 코드 외에 `server.js`에서 불러오는 뉴스·리포트·Q&A·시나리오·실시간 서버 모듈도 있습니다. `src/trading/js/app.js`는 별도 진입 구현이며 기본 `npm start` 실행 경로에는 포함되지 않습니다. `src/config.js`의 Key Vault 연동도 기본 서버가 직접 불러오지는 않습니다.

## 명령을 실행할 위치

정적 화면 미리보기는 **저장소 최상위**에서 실행합니다.

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory src/public
```

향후 환경을 재구축할 때 Node 명령은 **`src/` 안에서** 실행합니다. 코드가 작업 폴더의 `public/`과 `.env`를 사용하기 때문입니다.

```bash
cd src
npm ci
cp .env.example .env
# DB · 데이터 · 인증 등 외부 환경을 먼저 재구축하고 .env 설정
npm start
```

위 명령만으로 현재 서비스가 복구되지는 않습니다. [재구축 가이드](RECOVERY_GUIDE.md)의 준비와 검증이 선행되어야 합니다. `npm test`는 실제 자동 테스트가 구현되지 않은 기본 명령입니다.

Docker 빌드 컨텍스트도 `src/`입니다. 저장소 최상위에서는 `docker build -t itc-local ./src`를 사용하며, 이 이미지가 DB·인증 등의 외부 서비스를 생성하지는 않습니다. Skaffold 예시는 `src/` 안에서 실행하는 구성을 기준으로 합니다.
