// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Source: owner-supplied Rolling Trade-Loop & Omni-Chain Spec v3.0, pp. 2-5.
// Execution corrections and source mapping: CRYPTO_ROLLING.md.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AVISGreenRollingSecurityToken is ERC20, ERC20Permit, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant MASTER_HUB_ROLE = keccak256("MASTER_HUB_ROLE");
    bytes32 public constant ALGO_BOT_ROLE = keccak256("ALGO_BOT_ROLE");
    IERC20 public immutable agStablecoin;
    IERC20 public immutable agiToken;
    address public immutable treasuryCashPool;
    struct AssetDossier {
        string isin; string cusip; string assetType; string collateralHouseRef;
        uint256 faceValuePerToken; uint256 marginHaircutBps; uint256 tradingFeeBps;
        uint256 goldGramsPerToken1e6; bool greenHighTechVerified;
    }
    enum TradeStatus { NONE, HOLD_PENDING_NEXT, SETTLED_BY_NEXT, CLOSED }
    struct RollingTradeLeg {
        uint256 sequenceId; address botOperator; address settlementToken;
        uint256 securityAmount; uint256 grossSettlementValue; uint256 netPayoutToPrevious;
        uint256 feeAndCashBenefit; TradeStatus status; uint256 timestamp;
    }
    AssetDossier public dossier;
    mapping(address => bool) public isKycedInvestor;
    mapping(address => bool) public isApprovedExchangeOrPool;
    mapping(address => bool) public isFrozen;
    mapping(address => uint256) public lockedMarginCollateral;
    mapping(address => uint256) public committedMarginPower;
    mapping(address => uint256) public committedSecurityAmount;
    mapping(uint256 => uint256) public activeSequenceByChannel;
    mapping(uint256 => mapping(uint256 => RollingTradeLeg)) public channelTrades;
    mapping(address => uint256) public settlementEscrow;
    mapping(address => uint256) public accumulatedCashBenefitByToken;
    uint256 public totalAccumulatedCashBenefit;
    event MarginCollateralLocked(address indexed operator, uint256 tokenAmount, uint256 availableTradingPower);
    event MarginCollateralReleased(address indexed operator, uint256 tokenAmount);
    event RollingTradeInitiatedAndHeld(uint256 indexed channelId, uint256 indexed sequenceId, address indexed bot, uint256 securityAmount, uint256 grossValue);
    event RollingTradeSettledByNext(uint256 indexed channelId, uint256 indexed settledSequenceId, uint256 indexed payingSequenceId, uint256 netPaid, uint256 cashBenefitGenerated);
    event RollingChannelClosed(uint256 indexed channelId, uint256 indexed sequenceId, uint256 netPaid, uint256 fee);
    event RollingJournal(bytes32 indexed journalId, uint256 indexed channelId, uint256 indexed sequenceId, address settlementToken, uint256 netPaid, uint256 fee);
    event PhysicalGoldRedeemed(address indexed holder, uint256 tokensBurned, uint256 goldGrams1e6, string vaultDeliveryRef);
    event ExchangeVenueApproved(address indexed venue, string venueName, bool status);
    event InvestorKycSet(address indexed wallet, bool status);
    event RegistrarForcedTransfer(address indexed from, address indexed to, uint256 amount, string legalRef);
    constructor(string memory name_, string memory symbol_, AssetDossier memory initialDossier_, address ag, address agi, address treasury, address registrar, address hub)
      ERC20(name_,symbol_) ERC20Permit(name_) {
        require(ag!=address(0) && agi!=address(0) && ag!=agi && treasury!=address(0) && registrar!=address(0) && hub!=address(0), "Invalid address");
        require(ag.code.length>0 && agi.code.length>0, "Settlement token code required");
        require(initialDossier_.greenHighTechVerified && bytes(initialDossier_.isin).length>0 && bytes(initialDossier_.collateralHouseRef).length>0, "Verified asset dossier required");
        require(initialDossier_.faceValuePerToken>0 && initialDossier_.marginHaircutBps<10000 && initialDossier_.tradingFeeBps<=10000, "Invalid asset terms");
        dossier=initialDossier_; agStablecoin=IERC20(ag); agiToken=IERC20(agi); treasuryCashPool=treasury;
        _grantRole(DEFAULT_ADMIN_ROLE,registrar); _grantRole(REGISTRAR_ROLE,registrar);
        _grantRole(MASTER_HUB_ROLE,hub); _grantRole(ALGO_BOT_ROLE,registrar);
        isApprovedExchangeOrPool[hub]=true; isApprovedExchangeOrPool[registrar]=true;
        isApprovedExchangeOrPool[treasury]=true; isApprovedExchangeOrPool[address(this)]=true;
    }
    function lockSecurityForMargin(uint256 tokenAmount) external nonReentrant whenNotPaused {
        require(tokenAmount>0,"Amount required"); _transfer(msg.sender,address(this),tokenAmount);
        lockedMarginCollateral[msg.sender]+=tokenAmount;
        emit MarginCollateralLocked(msg.sender,tokenAmount,getAvailableTradingPower(msg.sender));
    }
    function releaseMarginCollateral(uint256 tokenAmount) external nonReentrant whenNotPaused {
        require(tokenAmount>0 && lockedMarginCollateral[msg.sender]>=tokenAmount,"Insufficient locked margin");
        uint256 remaining=lockedMarginCollateral[msg.sender]-tokenAmount;
        require(remaining>=committedSecurityAmount[msg.sender] && _power(remaining)>=committedMarginPower[msg.sender],"Active trade collateral");
        lockedMarginCollateral[msg.sender]=remaining; _transfer(address(this),msg.sender,tokenAmount);
        emit MarginCollateralReleased(msg.sender,tokenAmount);
    }
    function _power(uint256 amount) internal view returns(uint256) {
        return ((amount*dossier.faceValuePerToken)/1e18)*(10000-dossier.marginHaircutBps)/10000;
    }
    function getAvailableTradingPower(address operator) public view returns(uint256) {
        return _power(lockedMarginCollateral[operator])-committedMarginPower[operator];
    }
    function executeRollingTradeStep(uint256 channelId,address settlementToken,uint256 securityAmount,uint256 grossTradeValue)
      external onlyRole(ALGO_BOT_ROLE) nonReentrant whenNotPaused {
        _executeSingleInternal(channelId,settlementToken,securityAmount,grossTradeValue);
    }
    function executeParallelRollingBatch(uint256[] calldata channels,address settlementToken,uint256[] calldata amounts,uint256[] calldata values)
      external onlyRole(ALGO_BOT_ROLE) nonReentrant whenNotPaused {
        require(channels.length>0 && channels.length<=32 && channels.length==amounts.length && channels.length==values.length,"Invalid batch");
        for(uint256 i;i<channels.length;i++) {
            for(uint256 j;j<i;j++) require(channels[j]!=channels[i],"Duplicate channel");
            _executeSingleInternal(channels[i],settlementToken,amounts[i],values[i]);
        }
    }
    function _executeSingleInternal(uint256 channelId,address settlementToken,uint256 securityAmount,uint256 grossTradeValue) internal {
        require(settlementToken==address(agStablecoin) || settlementToken==address(agiToken),"Settlement must be AG or AGi");
        require(securityAmount>0 && grossTradeValue>0 && !isFrozen[msg.sender],"Invalid trade");
        uint256 prevSeq=activeSequenceByChannel[channelId];
        RollingTradeLeg storage previous=channelTrades[channelId][prevSeq];
        bool rolling=previous.status==TradeStatus.HOLD_PENDING_NEXT;
        if(rolling) {
            require(previous.botOperator==msg.sender,"Channel belongs to another operator");
            require(previous.settlementToken==settlementToken && previous.grossSettlementValue==grossTradeValue && previous.securityAmount==securityAmount,"Close channel before changing terms");
        } else {
            require(getAvailableTradingPower(msg.sender)>=grossTradeValue,"Exceeds available margin");
            require(lockedMarginCollateral[msg.sender]-committedSecurityAmount[msg.sender]>=securityAmount,"Exceeds available security");
            committedMarginPower[msg.sender]+=grossTradeValue; committedSecurityAmount[msg.sender]+=securityAmount;
        }
        IERC20 cash=IERC20(settlementToken); uint256 beforeBalance=cash.balanceOf(address(this));
        cash.safeTransferFrom(msg.sender,address(this),grossTradeValue);
        require(cash.balanceOf(address(this))-beforeBalance==grossTradeValue,"Exact settlement required");
        uint256 fee=grossTradeValue*dossier.tradingFeeBps/10000; uint256 net=grossTradeValue-fee; uint256 newSeq=prevSeq+1;
        if(rolling) {
            previous.status=TradeStatus.SETTLED_BY_NEXT;
            _pay(settlementToken,msg.sender,previous.netPayoutToPrevious,previous.feeAndCashBenefit);
            emit RollingTradeSettledByNext(channelId,prevSeq,newSeq,previous.netPayoutToPrevious,previous.feeAndCashBenefit);
            _journal(channelId,prevSeq,settlementToken,previous.netPayoutToPrevious,previous.feeAndCashBenefit);
        } else settlementEscrow[settlementToken]+=grossTradeValue;
        channelTrades[channelId][newSeq]=RollingTradeLeg(newSeq,msg.sender,settlementToken,securityAmount,grossTradeValue,net,fee,TradeStatus.HOLD_PENDING_NEXT,block.timestamp);
        activeSequenceByChannel[channelId]=newSeq;
        emit RollingTradeInitiatedAndHeld(channelId,newSeq,msg.sender,securityAmount,grossTradeValue);
    }
    function closeRollingChannel(uint256 channelId) external nonReentrant whenNotPaused {
        uint256 seq=activeSequenceByChannel[channelId]; RollingTradeLeg storage leg=channelTrades[channelId][seq];
        require(leg.status==TradeStatus.HOLD_PENDING_NEXT && leg.botOperator==msg.sender,"Select own active channel");
        leg.status=TradeStatus.CLOSED; committedMarginPower[msg.sender]-=leg.grossSettlementValue;
        committedSecurityAmount[msg.sender]-=leg.securityAmount; settlementEscrow[leg.settlementToken]-=leg.grossSettlementValue;
        _pay(leg.settlementToken,msg.sender,leg.netPayoutToPrevious,leg.feeAndCashBenefit);
        _journal(channelId,seq,leg.settlementToken,leg.netPayoutToPrevious,leg.feeAndCashBenefit);
        emit RollingChannelClosed(channelId,seq,leg.netPayoutToPrevious,leg.feeAndCashBenefit);
    }
    function _pay(address token,address recipient,uint256 net,uint256 fee) private {
        IERC20(token).safeTransfer(recipient,net);
        if(fee>0){ IERC20(token).safeTransfer(treasuryCashPool,fee); totalAccumulatedCashBenefit+=fee; accumulatedCashBenefitByToken[token]+=fee; }
    }
    function _journal(uint256 channel,uint256 seq,address token,uint256 net,uint256 fee) private {
        emit RollingJournal(keccak256(abi.encode(block.chainid,address(this),channel,seq)),channel,seq,token,net,fee);
    }
    function redeemForPhysicalGold(uint256 amount,string calldata deliveryRef) external nonReentrant whenNotPaused {
        require(amount>0 && dossier.goldGramsPerToken1e6>0 && bytes(deliveryRef).length>0,"Gold redemption terms required");
        uint256 grams=amount*dossier.goldGramsPerToken1e6/1e18; require(grams>0,"Amount too small");
        _burn(msg.sender,amount); emit PhysicalGoldRedeemed(msg.sender,amount,grams,deliveryRef);
    }
    function setInvestorKyc(address investor,bool status) external onlyRole(REGISTRAR_ROLE) {isKycedInvestor[investor]=status;emit InvestorKycSet(investor,status);}
    function setApprovedExchangeVenue(address venue,string calldata name_,bool status) external onlyRole(REGISTRAR_ROLE) {require(venue!=address(this),"Escrow venue is fixed");isApprovedExchangeOrPool[venue]=status;emit ExchangeVenueApproved(venue,name_,status);}
    function setFrozen(address investor,bool status) external onlyRole(REGISTRAR_ROLE) {require(investor!=address(this),"Escrow address is fixed");isFrozen[investor]=status;}
    function registrarForcedTransfer(address from,address to,uint256 amount,string calldata legalRef) external onlyRole(REGISTRAR_ROLE) {
        require(from!=address(this) && bytes(legalRef).length>0,"Legal reference required"); _transfer(from,to,amount);emit RegistrarForcedTransfer(from,to,amount,legalRef);
    }
    function hubMint(address to,uint256 amount) external onlyRole(MASTER_HUB_ROLE) whenNotPaused {require(to!=address(this) && amount>0,"Invalid mint");_mint(to,amount);}
    function hubBurn(address from,uint256 amount) external onlyRole(MASTER_HUB_ROLE) whenNotPaused {require(from!=address(this) && amount>0,"Invalid burn");_burn(from,amount);}
    function pause() external onlyRole(REGISTRAR_ROLE){_pause();}
    function unpause() external onlyRole(REGISTRAR_ROLE){_unpause();}
    function _update(address from,address to,uint256 amount) internal override whenNotPaused {
        if(from!=address(0))require(!isFrozen[from] && (isKycedInvestor[from]||isApprovedExchangeOrPool[from]),"Sender not authorized");
        if(to!=address(0))require(!isFrozen[to] && (isKycedInvestor[to]||isApprovedExchangeOrPool[to]),"Recipient not authorized");
        super._update(from,to,amount);
    }
}
