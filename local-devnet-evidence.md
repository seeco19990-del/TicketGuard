# TicketGuard 로컬 Devnet 실행 증거

출처: 사용자가 PowerShell에서 실행한 `npm.cmd test` 로그. 체인: 프로세스 내 Ganache 로컬 개발망. AI: `--demo` 모의 named function call, 실제 Kiln 요청 없음. `usage.total_tokens=0`은 모의값이며 실제 추론 토큰이 아닙니다. Ganache는 실행마다 새 체인을 생성하므로 아래 해시는 공개 익스플로러에서 조회할 수 없습니다.

| Flow | 결과 | 로그상 근거 | 해시 |
|---|---|---|---|
| Test 1 정상 거래 | PASS | 판매가 600,000 mKRW, 판매자 480,000(80%), 기부 120,000(20%), EIP-712 서명 복원 일치 | `0x983796981ec4e25f96026927a5d7c28a75551299386aa7df46fae09f11184f91` |
| Test 2 1.5배 초과 | STOP | `MARKUP_CAP: 310000 KRW > 150% of 200000 KRW`; `CALL_EXCEPTION reason=MARKUP_CAP`; 매물 생성 안 됨, nonce 미사용, NFT 판매자 보유 | 없음 |
| Test 3 스포츠 절대 상한 | STOP | `ABSOLUTE_CAP: 510000 KRW > 500000 KRW`; `CALL_EXCEPTION reason=ABSOLUTE_CAP`; 매물 생성 안 됨, nonce 미사용, NFT 판매자 보유 | 없음 |
| Test 4 행사 취소 | PASS | 구매자 600,000/600,000 mKRW 환불, NFT 판매자 반환, EIP-712 서명 복원 일치 | `0x185a0729a69c66d5ea51bc3a3e17e6a128700946f9b87179105c7612a7dd91f2` |

실행 당시 컨트랙트 주소: TicketEscrow `0x9bFFCD4cf257De2C3D69600eb560A58F6229051C`, MockKRW `0x025D71A55d711211117D2b9586a6ECB721248e6f`, MockTicket `0xD1bE3Cd5D464f058a235ced5e9f9129C00AbcB80`.

**남은 제출 항목:** 새로 발급받은 Kiln API 키로 `npm.cmd run test:kiln`을 실행해 실제 `qwen3-32b` tool call과 Flow별 실측 토큰을 확보해야 합니다. 공개 Testnet 검증이 요구된다면 별도 RPC/배포/자금 지원으로 재실행하고 공개 익스플로러 해시 및 영수증을 기록해야 합니다. 이전에 채팅에 게시한 키는 폐기 대상으로 취급하세요.
