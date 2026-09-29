# 🛡️ TicketGuard: AI-Driven Decentralized Ticketing Market

> **암표 근절과 안전한 거래를 위한 AI 기반 에스크로 & 안티프라우드 티켓팅 플랫폼**  
> *(GWDC 해커톤 출품작)*

---

## 📌 1. 프로젝트 개요 (Project Overview)
**TicketGuard**는 콘서트, 스포츠 경기 등 티켓팅 시장에서 만연한 암표 거래와 사기 피해를 방지하기 위해 고안된 블록체인 기반 탈중앙화 티켓 마켓플레이스입니다. 
AI 기반의 가격 상한선 검증 알고리즘과 스마트 컨트랙트 에스크로 시스템을 결합하여, 투명하고 공정한 티켓 재판매 생태계를 구축합니다.

---

## ⚙️ 2. 주요 기능 및 특징 (Key Features)
1. **가격 상한선 및 조건부 검증 (Anti-Scalping Rule)**
   * 비정상적인 고가 재판매(암표) 시도를 사전에 탐지하고 차단하는 가격 검증 로직 구현.
2. **스마트 컨트랙트 에스크로 시스템 (Escrow System)**
   * 구매자의 구매 대금을 컨트랙트에 예치하고, 거래 및 티켓 수령이 안전하게 완료될 때까지 대금을 보호하는 에스크로 보증금 구조 적용.
3. **신뢰 기반 거래 보장**
   * 블록체인 불변성을 활용해 티켓 위·변조 및 이중 판매 원천 차단.

---

## 🏗️ 3. 시스템 아키텍처 (System Architecture)
* **Frontend / UI**: 사용자가 티켓을 등록하고, 가격 제한 검증 및 에스크로 결제 상태를 직관적으로 이용할 수 있는 웹 인터페이스.
* **Smart Contract (Solidity)**: 탈중앙화된 에스크로 보증금과 거래 상태를 안전하게 관리하는 온체인 비즈니스 로직.

---

## ⛓️ 4. 온체인 트랜잭션 및 배포 검증 (On-Chain Verification)
본 프로젝트의 스마트 컨트랙트 및 에스크로 결제 로직은 테스트넷 시뮬레이션 환경(Remix VM)에서 정상적으로 마이닝 및 검증을 완료했습니다.

* **Network**: Remix VM (Simulation / Testnet Environment)
* **Contract Address**: `0xf8e81D47203A594245E36C48e151709F0C19fBe8`
* **Escrow Purchase Tx Hash**: `0x0cf9093c3ccb9a395c6909c75104bbc88c5d6ac57cfb1997be209989687a9a9f`
* **Execution Log Summary**:
  * Function Called: `purchaseTicket(uint256 _id)`
  * Input Arguments: ID `1`, Value `100000 wei`
  * Status: `Transaction mined and execution completed (Success)`

---

## 📂 5. 프로젝트 구조 (Repository Structure)
```text
TicketGuard/
├── contracts/
│   └── TicketGuard.sol       # 에스크로 및 티켓 관리 스마트 컨트랙트
├── frontend/                 # 프론트엔드 UI 및 웹 로직 파일
└── README.md                 # 프로젝트 가이드 문서


6. 설치 및 실행 방법 (Getting Started)
Smart Contract 확인

Remix IDE (remix.ethereum.org)에 접속하여 contracts/TicketGuard.sol 코드를 컴파일합니다.

Remix VM 환경에서 배포 및 에스크로 결제 테스트를 재현할 수 있습니다.

Frontend 실행

제공된 프론트엔드 웹 인터페이스를 통해 티켓 등록 및 가격 검증 기능을 시연할 수 있습니다.