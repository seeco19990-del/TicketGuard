# 🎫 TicketGuard (GWDC Hackathon Prototype)

TicketGuard는 암표 거래를 방지하고 안전한 티켓 양도를 보장하는 AI 기반 스마트 컨트랙트 에스크로 시스템입니다. 

## 💡 핵심 기능
1. **AI Price Guard (Kiln API - qwen3-32b 적용)**
   * 판매자가 티켓을 등록할 때, AI가 원래 티켓 가격과 상한선(스포츠 50만 원, 콘서트 100만 원 및 원가 150% 이하)을 즉각적으로 분석하여 폭리를 취하는 거래(리스팅)를 원천 차단합니다.
2. **블록체인 에스크로 (Solidity / Ganache)**
   * 구매자의 결제 대금과 판매자의 티켓(NFT)을 컨트랙트에 안전하게 보관합니다.
   * 정상 거래 완료 시 판매자 80%, 지정 기부처에 20%가 자동 정산되며, 행사 취소 시 구매자에게 100% 자동 환불됩니다.

## 📊 검증 결과
로컬 개발 환경(Ganache Devnet)과 실제 AI 모델을 연동하여 4가지 핵심 시나리오를 100% 통과했습니다.

### 💻 실행 로그 (Proof of Work)
=== FLOW-BY-FLOW TOKEN REPORT ===
Flow Test 1: PASS | usage.total_tokens=428 | txHash=0x6274cc92c2863ff917bae13d196bb544116cc915f746c8c6346bd6ed76e263aa
Flow Test 2: STOP: MARKUP_CAP | usage.total_tokens=414 | txHash=none
Flow Test 3: STOP: ABSOLUTE_CAP | usage.total_tokens=396 | txHash=none
Flow Test 4: PASS: FULL REFUND | usage.total_tokens=460 | txHash=0xcea3bc001d700bb649479040224ed8b3ba3b335853507bd6eac77ec1bde44a77
NOTE: Ganache hashes are LOCAL DEVNET ONLY. In --demo mode, AI tokens=0 are simulated, not Kiln usage.