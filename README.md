# ITC · 암호화폐 투자 학습 플랫폼

실시간 모의투자와 과거 시장 시뮬레이션을 통해 투자를 학습하고, AI 뉴스·백과사전·개인 리포트로 학습과 복기를 연결하는 팀 프로젝트입니다.

## 주요 기능

- 실시간 시세와 모의 매매, 시장가·지정가 주문
- 과거 시장 시나리오 기반 투자 실습
- AI 뉴스와 투자 학습 도우미
- 암호화폐 백과사전, 개인 리포트, Q&A
- Keycloak 기반 인증

## 담당 역할

PM 및 Data Engineer로서 로드맵·리스크 관리, 과거 시나리오와 백과사전 설계, Fabric–Lakehouse–Power BI 고객·거래 분석 흐름을 담당했습니다. 웹 서비스·거래 엔진·인증·배포 코드는 팀 공동 산출물입니다.

## 기술과 구조

Node.js · Express · WebSocket · MySQL · Keycloak · Azure Functions · Docker · Kubernetes · Azure DevOps

```text
server.js               Express 서버
public/                 웹 화면, JavaScript, CSS, 이미지·음성
services/               DB, 이메일, 자산, 인증 서비스
trading/                거래 서비스, 주문 매칭, WebSocket
azure_function_app.py   뉴스 수집·AI 분석용 Python 코드
k8s/                    Kubernetes 설정
azure-pipelines.yml     기존 Azure DevOps 배포 설정
```

Fabric·Power BI 분석은 외부 클라우드 산출물이며 이 저장소에 전체 구성이 포함되어 있지는 않습니다.

## 실행 준비

1. Node.js 20 환경에서 `npm ci`로 의존성을 설치합니다.
2. `.env.example`을 `.env`로 복사하고 실제 사용하는 DB·Keycloak·SMTP·AI 설정을 입력합니다.
3. MySQL 스키마와 외부 인증·API 서비스를 별도로 준비한 뒤 `npm start`를 실행합니다.

이 저장소는 프로젝트 소스 백업이며, DB 초기화 스크립트와 외부 클라우드 리소스 전체를 제공하지 않습니다. 설치만으로 모든 기능이 실행되지는 않습니다. `npm test`는 원본의 기본 명령으로, 자동 테스트가 구현되어 있지 않습니다.

Python 뉴스 코드는 별도 Azure Functions 환경과 Python 의존성이 필요합니다. `config.js`의 Azure Key Vault SDK 의존성은 현재 Node 패키지 목록에 포함되어 있지 않습니다.

`SESSION_SECRET`에 강한 임의 값을 설정합니다. `LLM_API_ENDPOINT`, `PUBLIC_BASE_URL`, `AZURE_KEY_VAULT_NAME`은 자신의 환경에 맞게 입력합니다. 관리자 계정 목록과 조직 보고서 링크는 공개 소스에서 제거했습니다.

## 배포 참고

[Azure 배포 설정 안내](docs/AZURE_DEPLOYMENT.md)를 참고하세요. 저장소의 Azure DevOps·Kubernetes 설정은 해당 인프라에 종속되므로 자신의 리소스로 변경해야 합니다. GitHub에 코드를 업로드하는 것만으로 서비스가 배포되지는 않습니다.

## 자료 보존

원본의 Git 이력, 가상환경, 로컬 캐시, 환경변수 파일을 제외한 소스 스냅샷입니다. 원본 코드는 팀 프로젝트 산출물이며 이 저장소에서 별도의 오픈소스 라이선스를 부여하지 않습니다.
