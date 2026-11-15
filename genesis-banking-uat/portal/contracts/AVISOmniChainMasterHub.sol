// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./AVISGreenRollingSecuritySystem.sol";

contract AVISRollingTokenFactory {
    address public immutable hub;
    constructor(address hub_) { hub=hub_; }
    function deploy(string calldata name_,string calldata symbol_,AVISGreenRollingSecurityToken.AssetDossier calldata dossier_,address ag,address agi,address treasury,address registrar) external returns(address) {
        require(msg.sender==hub,"Hub only");
        return address(new AVISGreenRollingSecurityToken{salt:keccak256(bytes(dossier_.isin))}(name_,symbol_,dossier_,ag,agi,treasury,registrar,hub));
    }
}

// Owner's v3.0 factory/bridge interface, with custody caps and source-event replay protection.
contract AVISOmniChainMasterHub is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant REGISTRAR_ROLE=keccak256("REGISTRAR_ROLE");
    bytes32 public constant COLLATERAL_CUSTODIAN_ROLE=keccak256("COLLATERAL_CUSTODIAN_ROLE");
    bytes32 public constant MPC_BRIDGE_ROLE=keccak256("MPC_BRIDGE_ROLE");
    AVISRollingTokenFactory public immutable tokenFactory;
    IERC20 public immutable agToken; IERC20 public immutable agiToken; address public immutable treasuryCashPool;
    mapping(string=>address) public securityByIsin; mapping(address=>string) public isinByToken;
    mapping(bytes32=>bool) public processedJournals; mapping(bytes32=>bool) public processedSourceEvents;
    mapping(address=>uint256) public custodyCap; mapping(address=>uint256) public bridgedOutSupply;
    mapping(bytes32=>bool) public approvedRemoteHubs;
    event RollingSecurityDeployed(string indexed isin,address indexed tokenAddress,string name,string symbol);
    event CustodySupplySet(address indexed token,uint256 cap,bytes32 indexed custodyReference);
    event SecurityBooked(address indexed token,address indexed recipient,uint256 amount,bytes32 indexed journalId);
    event CrossChainBridgeOut(address indexed sender,address indexed token,string isin,uint256 amount,string targetChain,string targetRecipient,bytes32 indexed journalId);
    event CrossChainBridgeIn(address indexed recipient,address indexed token,string isin,uint256 amount,string sourceChain,bytes32 sourceTxHash,bytes32 indexed journalId);
    constructor(address ag,address agi,address treasury,address registrar,address bridgeSigner){
        require(ag!=agi && ag.code.length>0 && agi.code.length>0 && treasury!=address(0) && registrar!=address(0) && bridgeSigner!=address(0),"Invalid hub parameters");
        tokenFactory=new AVISRollingTokenFactory(address(this));
        agToken=IERC20(ag);agiToken=IERC20(agi);treasuryCashPool=treasury;
        _grantRole(DEFAULT_ADMIN_ROLE,registrar);_grantRole(REGISTRAR_ROLE,registrar);_grantRole(COLLATERAL_CUSTODIAN_ROLE,registrar);_grantRole(MPC_BRIDGE_ROLE,bridgeSigner);
    }
    function deployRollingSecurityDeterministic(string calldata name_,string calldata symbol_,AVISGreenRollingSecurityToken.AssetDossier calldata dossier_)
      external onlyRole(COLLATERAL_CUSTODIAN_ROLE) whenNotPaused returns(address){
        require(securityByIsin[dossier_.isin]==address(0),"ISIN exists");
        address addr=tokenFactory.deploy(name_,symbol_,dossier_,address(agToken),address(agiToken),treasuryCashPool,msg.sender);securityByIsin[dossier_.isin]=addr;isinByToken[addr]=dossier_.isin;
        emit RollingSecurityDeployed(dossier_.isin,addr,name_,symbol_);return addr;
    }
    function setCustodyCap(address token,uint256 cap,bytes32 custodyRef) external onlyRole(COLLATERAL_CUSTODIAN_ROLE){
        require(bytes(isinByToken[token]).length>0 && custodyRef!=bytes32(0),"Registered custody required");
        require(cap>=IERC20(token).totalSupply()+bridgedOutSupply[token],"Cap below issued supply");
        custodyCap[token]=cap;emit CustodySupplySet(token,cap,custodyRef);
    }
    function mintCustodiedSecurity(address token,address recipient,uint256 amount,bytes32 journalId) external onlyRole(COLLATERAL_CUSTODIAN_ROLE) nonReentrant whenNotPaused {
        _journal(journalId);require(bytes(isinByToken[token]).length>0 && amount>0,"Registered security required");
        require(IERC20(token).totalSupply()+bridgedOutSupply[token]+amount<=custodyCap[token],"Custody cap exceeded");
        AVISGreenRollingSecurityToken(token).hubMint(recipient,amount);emit SecurityBooked(token,recipient,amount,journalId);
    }
    function setRemoteChain(string calldata chain,bool approved) external onlyRole(REGISTRAR_ROLE){require(bytes(chain).length>0,"Chain required");approvedRemoteHubs[keccak256(bytes(chain))]=approved;}
    function _journal(bytes32 journalId) internal {require(journalId!=bytes32(0)&&!processedJournals[journalId],"Duplicate journalId");processedJournals[journalId]=true;}
    function bridgeToAnyChain(address token,uint256 amount,string calldata targetChain,string calldata recipient,bytes32 journalId) external nonReentrant whenNotPaused {
        require(amount>0 && bytes(recipient).length>0 && approvedRemoteHubs[keccak256(bytes(targetChain))],"Select registered destination");_journal(journalId);
        string memory isin=isinByToken[token];
        if(bytes(isin).length>0){AVISGreenRollingSecurityToken(token).hubBurn(msg.sender,amount);bridgedOutSupply[token]+=amount;}
        else{require(token==address(agToken)||token==address(agiToken),"Unsupported token");uint256 beforeBalance=IERC20(token).balanceOf(address(this));IERC20(token).safeTransferFrom(msg.sender,address(this),amount);require(IERC20(token).balanceOf(address(this))-beforeBalance==amount,"Exact bridge funding required");}
        emit CrossChainBridgeOut(msg.sender,token,isin,amount,targetChain,recipient,journalId);
    }
    function completeBridgeFromAnyChain(address recipient,address token,uint256 amount,string calldata sourceChain,bytes32 sourceTxHash,bytes32 journalId)
      external onlyRole(MPC_BRIDGE_ROLE) nonReentrant whenNotPaused {
        require(recipient!=address(0)&&amount>0&&sourceTxHash!=bytes32(0)&&approvedRemoteHubs[keccak256(bytes(sourceChain))],"Verified source required");_journal(journalId);
        // v3 interface has no source log index: accept at most one receipt per source transaction.
        bytes32 source=keccak256(abi.encode(sourceChain,sourceTxHash));require(!processedSourceEvents[source],"Source already processed");processedSourceEvents[source]=true;
        string memory isin=isinByToken[token];
        if(bytes(isin).length>0){require(bridgedOutSupply[token]>=amount,"Unbacked bridge receipt");bridgedOutSupply[token]-=amount;require(IERC20(token).totalSupply()+bridgedOutSupply[token]+amount<=custodyCap[token],"Custody cap exceeded");AVISGreenRollingSecurityToken(token).hubMint(recipient,amount);}
        else{require(token==address(agToken)||token==address(agiToken),"Unsupported token");IERC20(token).safeTransfer(recipient,amount);}
        emit CrossChainBridgeIn(recipient,token,isin,amount,sourceChain,sourceTxHash,journalId);
    }
    function pause() external onlyRole(REGISTRAR_ROLE){_pause();}
    function unpause() external onlyRole(REGISTRAR_ROLE){_unpause();}
}
