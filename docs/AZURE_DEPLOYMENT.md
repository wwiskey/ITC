# Azure 배포 설정 안내

이 문서는 공개 소스용 설정 안내입니다. 원래 팀의 계정·저장소 주소·리소스 식별정보는 포함하지 않습니다.

1. 자신의 Azure Container Registry, AKS, Key Vault와 Azure DevOps 서비스 연결을 준비합니다.
2. `azure-pipelines.yml`의 `YOUR_*` 값을 자신의 환경으로 바꿉니다. 자동 실행은 기본적으로 꺼져 있습니다.
3. Key Vault에 DB·Keycloak·SMTP·LLM 등 필요한 값을 저장하고 최소 권한으로 접근을 설정합니다.
4. Kubernetes 네임스페이스와 서비스 계정, 이미지 경로를 자신의 환경에 맞춥니다.
5. `.env.example`의 항목을 참고하되 실제 인증정보는 Git에 커밋하지 않습니다.

`config.js`를 사용하는 경우 `AZURE_KEY_VAULT_NAME`과 Azure 자격 증명, 해당 SDK 의존성을 별도로 준비해야 합니다.
서버의 `SESSION_SECRET`은 충분히 긴 임의 값으로 설정합니다. 미설정 시 실행마다 새 임시 값이 사용되어 재시작 시 기존 세션이 무효화됩니다.
`LLM_API_ENDPOINT`와 `PUBLIC_BASE_URL`에는 자신의 서비스 URL을 설정합니다.
관리자 이메일 목록과 외부 분석 보고서 링크는 공개 화면에서 제거했습니다. 필요한 경우 서버 권한 검사를 거쳐 별도로 연결합니다.
