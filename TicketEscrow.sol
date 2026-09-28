// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Prototype: MockKRW has 0 decimals, so one token unit represents one KRW.
// Replace both mock contracts with audited, issuer-controlled assets in production.
interface IERC20Payment {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITicketNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function ticketData(uint256 tokenId) external view returns (uint8 category, uint256 facePriceKRW, bytes32 eventId);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

contract TicketEscrow is IERC721Receiver {
    enum Category { SPORT, CONCERT }
    enum State { NONE, LISTED, FUNDED, SETTLED, REFUNDED, WITHDRAWN }
    enum EventStatus { UNREGISTERED, ACTIVE, CANCELLED, COMPLETED }

    struct Listing {
        address seller;
        address buyer;
        uint256 tokenId;
        uint256 facePriceKRW;
        uint256 askingPriceKRW;
        bytes32 eventId;
        Category category;
        State state;
    }

    ITicketNFT public immutable ticket;
    IERC20Payment public immutable paymentToken;
    address public immutable organizer;
    address public immutable approvalSigner;
    address public immutable feeRecipient;
    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;
    mapping(bytes32 => EventStatus) public eventStatus;
    mapping(uint256 => bool) public usedNonces;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant APPROVAL_TYPEHASH = keccak256("ListingApproval(address ticket,uint256 tokenId,address seller,uint8 category,uint256 facePriceKRW,uint256 askingPriceKRW,bytes32 eventId,uint256 deadline,uint256 nonce)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 private locked = 1;
    address private expectedSeller;
    uint256 private expectedTokenId;

    event TicketListed(uint256 indexed listingId, uint256 indexed tokenId, address indexed seller, uint256 askingPriceKRW);
    event TicketBought(uint256 indexed listingId, address indexed buyer, uint256 amountKRW);
    event ListingWithdrawn(uint256 indexed listingId);
    event EventRegistered(bytes32 indexed eventId);
    event EventCancelled(bytes32 indexed eventId);
    event EventCompleted(bytes32 indexed eventId);
    event TransactionRefunded(uint256 indexed listingId, address indexed buyer, uint256 amountKRW);
    event TransactionCompleted(uint256 indexed listingId, address indexed buyer, uint256 sellerAmountKRW, uint256 donationKRW);

    modifier onlyOrganizer() { require(msg.sender == organizer, "NOT_ORGANIZER"); _; }
    modifier nonReentrant() { require(locked == 1, "REENTRANCY"); locked = 2; _; locked = 1; }

    constructor(address ticket_, address paymentToken_, address approvalSigner_, address feeRecipient_) {
        require(ticket_ != address(0) && paymentToken_ != address(0) && approvalSigner_ != address(0) && feeRecipient_ != address(0), "ZERO_ADDRESS");
        require(ticket_.code.length > 0 && paymentToken_.code.length > 0, "INVALID_ASSET_CONTRACT");
        ticket = ITicketNFT(ticket_);
        paymentToken = IERC20Payment(paymentToken_);
        organizer = msg.sender;
        approvalSigner = approvalSigner_;
        feeRecipient = feeRecipient_;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes("TicketGuard")), keccak256(bytes("1")), block.chainid, address(this)));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "BAD_SIGNATURE_LENGTH");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= HALF_ORDER && (v == 27 || v == 28), "BAD_SIGNATURE");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "BAD_SIGNATURE");
        return signer;
    }

    // Diagnostic view: verifies the same signed fields used by listTicket without changing state.
    function approvalSignerFor(uint256 tokenId, address seller, uint256 askingPriceKRW, uint256 deadline, uint256 nonce, bytes calldata signature)
        external view returns (address)
    {
        (uint8 category, uint256 facePriceKRW, bytes32 eventId) = ticket.ticketData(tokenId);
        bytes32 structHash = keccak256(abi.encode(
            APPROVAL_TYPEHASH, address(ticket), tokenId, seller, category,
            facePriceKRW, askingPriceKRW, eventId, deadline, nonce
        ));
        return _recover(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash)), signature);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(paymentToken).call(abi.encodeCall(IERC20Payment.transfer, (to, amount)));
        require(ok && (data.length == 0 || (data.length == 32 && abi.decode(data, (bool)))), "PAYMENT_TRANSFER_FAILED");
    }
    function _safeTransferFrom(address from, uint256 amount) private {
        (bool ok, bytes memory data) = address(paymentToken).call(abi.encodeCall(IERC20Payment.transferFrom, (from, address(this), amount)));
        require(ok && (data.length == 0 || (data.length == 32 && abi.decode(data, (bool)))), "PAYMENT_TRANSFER_FROM_FAILED");
    }

    function listTicket(uint256 tokenId, uint256 askingPriceKRW, uint256 deadline, uint256 nonce, bytes calldata aiApproval)
        external nonReentrant returns (uint256 listingId)
    {
        require(block.timestamp <= deadline, "APPROVAL_EXPIRED");
        require(!usedNonces[nonce], "NONCE_USED");
        require(ticket.ownerOf(tokenId) == msg.sender, "NOT_TICKET_OWNER");
        (uint8 rawCategory, uint256 facePriceKRW, bytes32 eventId) = ticket.ticketData(tokenId);
        require(rawCategory <= uint8(Category.CONCERT) && eventId != bytes32(0), "BAD_TICKET");
        require(eventStatus[eventId] == EventStatus.ACTIVE, "EVENT_NOT_ACTIVE");
        require(facePriceKRW > 0 && askingPriceKRW > 0, "BAD_PRICE");
        uint256 absoluteCap = rawCategory == uint8(Category.SPORT) ? 500_000 : 1_000_000;
        require(askingPriceKRW <= absoluteCap, "ABSOLUTE_CAP");
        require(askingPriceKRW <= facePriceKRW + facePriceKRW / 2, "MARKUP_CAP");

        bytes32 structHash = keccak256(abi.encode(
            APPROVAL_TYPEHASH, address(ticket), tokenId, msg.sender, rawCategory,
            facePriceKRW, askingPriceKRW, eventId, deadline, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        require(_recover(digest, aiApproval) == approvalSigner, "AI_APPROVAL_REQUIRED");
        usedNonces[nonce] = true;
        listingId = nextListingId++;
        listings[listingId] = Listing(msg.sender, address(0), tokenId, facePriceKRW, askingPriceKRW, eventId, Category(rawCategory), State.LISTED);
        expectedSeller = msg.sender;
        expectedTokenId = tokenId;
        ticket.safeTransferFrom(msg.sender, address(this), tokenId);
        expectedSeller = address(0);
        expectedTokenId = 0;
        emit TicketListed(listingId, tokenId, msg.sender, askingPriceKRW);
    }

    function buyTicket(uint256 listingId) external nonReentrant {
        Listing storage item = listings[listingId];
        require(item.state == State.LISTED && msg.sender != item.seller, "NOT_AVAILABLE");
        require(eventStatus[item.eventId] == EventStatus.ACTIVE, "EVENT_NOT_ACTIVE");
        item.state = State.FUNDED;
        item.buyer = msg.sender;
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        _safeTransferFrom(msg.sender, item.askingPriceKRW);
        require(paymentToken.balanceOf(address(this)) == beforeBalance + item.askingPriceKRW, "FEE_ON_TRANSFER_NOT_SUPPORTED");
        emit TicketBought(listingId, msg.sender, item.askingPriceKRW);
    }

    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage item = listings[listingId];
        require(item.state == State.LISTED && item.seller == msg.sender, "NOT_SELLER_OR_ACTIVE");
        item.state = State.WITHDRAWN;
        ticket.safeTransferFrom(address(this), item.seller, item.tokenId);
        emit ListingWithdrawn(listingId);
    }

    function registerEvent(bytes32 eventId) external onlyOrganizer {
        require(eventId != bytes32(0) && eventStatus[eventId] == EventStatus.UNREGISTERED, "EVENT_ALREADY_REGISTERED");
        eventStatus[eventId] = EventStatus.ACTIVE;
        emit EventRegistered(eventId);
    }

    function cancelEvent(bytes32 eventId) external onlyOrganizer {
        require(eventId != bytes32(0) && eventStatus[eventId] == EventStatus.ACTIVE, "EVENT_NOT_ACTIVE");
        eventStatus[eventId] = EventStatus.CANCELLED;
        emit EventCancelled(eventId);
    }

    function markEventCompleted(bytes32 eventId) external onlyOrganizer {
        require(eventId != bytes32(0) && eventStatus[eventId] == EventStatus.ACTIVE, "EVENT_NOT_ACTIVE");
        eventStatus[eventId] = EventStatus.COMPLETED;
        emit EventCompleted(eventId);
    }

    // Permissionless claim after the organizer cancels the event. Both transfers revert together on failure.
    function refundTransaction(uint256 listingId) external nonReentrant {
        Listing storage item = listings[listingId];
        require(eventStatus[item.eventId] == EventStatus.CANCELLED, "EVENT_NOT_CANCELLED");
        require(item.state == State.LISTED || item.state == State.FUNDED, "NOT_REFUNDABLE");
        bool paid = item.state == State.FUNDED;
        item.state = State.REFUNDED;
        ticket.safeTransferFrom(address(this), item.seller, item.tokenId);
        if (paid) _safeTransfer(item.buyer, item.askingPriceKRW);
        emit TransactionRefunded(listingId, item.buyer, paid ? item.askingPriceKRW : 0);
    }

    // Final atomic exchange only after the organizer confirms the event completed normally.
    function completeTransaction(uint256 listingId) external nonReentrant {
        Listing storage item = listings[listingId];
        require(item.state == State.FUNDED && eventStatus[item.eventId] == EventStatus.COMPLETED, "NOT_SETTLEABLE");
        item.state = State.SETTLED;
        uint256 donation = item.askingPriceKRW * 20 / 100;
        uint256 sellerAmount = item.askingPriceKRW - donation;
        ticket.safeTransferFrom(address(this), item.buyer, item.tokenId);
        _safeTransfer(item.seller, sellerAmount);
        _safeTransfer(feeRecipient, donation);
        emit TransactionCompleted(listingId, item.buyer, sellerAmount, donation);
    }

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external view override returns (bytes4)
    {
        require(msg.sender == address(ticket) && operator == address(this) && from == expectedSeller && tokenId == expectedTokenId, "UNEXPECTED_NFT");
        return IERC721Receiver.onERC721Received.selector;
    }
}

// DEMO ONLY: zero-decimal, centrally minted payment token, not actual KRW or a stablecoin.
contract MockKRW is IERC20Payment {
    string public constant name = "Mock KRW";
    string public constant symbol = "mKRW";
    uint8 public constant decimals = 0;
    address public immutable issuer;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    constructor() { issuer = msg.sender; }
    function mint(address to, uint256 amount) external {
        require(msg.sender == issuer && to != address(0), "NOT_ISSUER");
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) private {
        require(to != address(0) && balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

// DEMO ONLY: organizer-minted ticket NFT with immutable original category/price/event.
contract MockTicket is ITicketNFT {
    string public constant name = "TicketGuard Mock Ticket";
    string public constant symbol = "TGMT";
    address public immutable organizer;
    uint256 public nextTokenId = 1;
    struct Metadata { uint8 category; uint256 facePriceKRW; bytes32 eventId; }
    mapping(uint256 => Metadata) public override ticketData;
    mapping(uint256 => address) private owners;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    constructor() { organizer = msg.sender; }
    function ownerOf(uint256 tokenId) public view override returns (address) {
        address owner = owners[tokenId];
        require(owner != address(0), "UNKNOWN_TICKET");
        return owner;
    }
    function mint(address to, uint8 category, uint256 facePriceKRW, bytes32 eventId) external returns (uint256 tokenId) {
        require(msg.sender == organizer && to != address(0), "NOT_ORGANIZER");
        require(category <= 1 && facePriceKRW > 0 && eventId != bytes32(0), "BAD_METADATA");
        tokenId = nextTokenId++;
        ticketData[tokenId] = Metadata(category, facePriceKRW, eventId);
        owners[tokenId] = to;
        balanceOf[to]++;
        emit Transfer(address(0), to, tokenId);
    }
    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "NOT_AUTHORIZED");
        getApproved[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }
    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(owner == from && to != address(0), "BAD_TRANSFER");
        require(msg.sender == owner || getApproved[tokenId] == msg.sender || isApprovedForAll[owner][msg.sender], "NOT_AUTHORIZED");
        delete getApproved[tokenId];
        balanceOf[from]--;
        balanceOf[to]++;
        owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
    function safeTransferFrom(address from, address to, uint256 tokenId) public override {
        safeTransferFrom(from, to, tokenId, "");
    }
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) == IERC721Receiver.onERC721Received.selector, "NFT_RECEIVER_REJECTED");
        }
    }
}
