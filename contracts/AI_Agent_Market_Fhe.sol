pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract AIAgentMarketFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct AgentStats {
        euint32 encryptedTotalUses;
        euint32 encryptedTotalRevenue;
    }
    mapping(uint256 => AgentStats) public agentStats; // agentId => AgentStats

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidAgentId();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AgentNotInitialized();

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedContract(address indexed account);
    event UnpausedContract(address indexed account);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event AgentUseSubmitted(address indexed provider, uint256 indexed agentId, uint256 indexed batchId, euint32 encryptedUseCount, euint32 encryptedRevenue);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalUses, uint256 totalRevenue);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        paused = false;
        cooldownSeconds = 60; // Default cooldown: 1 minute
        currentBatchId = 1; // Start with batch 1
        batchOpen = false; // Batch closed by default
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                emit PausedContract(msg.sender);
            } else {
                emit UnpausedContract(msg.sender);
            }
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldownSeconds, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchClosed(); // Or a more specific error like "BatchAlreadyOpen"
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchClosed(); // Or "BatchAlreadyClosed"
        batchOpen = false;
        emit BatchClosed(currentBatchId);
        // Next batch will be currentBatchId + 1
    }

    function submitAgentUse(
        uint256 agentId,
        euint32 encryptedUseCount,
        euint32 encryptedRevenue
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchClosed();
        if (agentId == 0) revert InvalidAgentId();

        lastSubmissionTime[msg.sender] = block.timestamp;

        _initIfNeeded(agentId);

        agentStats[agentId].encryptedTotalUses = FHE.add(agentStats[agentId].encryptedTotalUses, encryptedUseCount);
        agentStats[agentId].encryptedTotalRevenue = FHE.add(agentStats[agentId].encryptedTotalRevenue, encryptedRevenue);

        emit AgentUseSubmitted(msg.sender, agentId, currentBatchId, encryptedUseCount, encryptedRevenue);
    }

    function requestAgentStatsDecryption(uint256 agentId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (agentId == 0) revert InvalidAgentId();
        if (!FHE.isInitialized(agentStats[agentId].encryptedTotalUses)) revert AgentNotInitialized();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 memory encryptedUses = agentStats[agentId].encryptedTotalUses;
        euint32 memory encryptedRevenue = agentStats[agentId].encryptedTotalRevenue;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(encryptedUses);
        cts[1] = FHE.toBytes32(encryptedRevenue);

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // @dev Replay Guard: Ensure this callback hasn't been processed for this requestId.
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // @dev State Verification: Rebuild the ciphertexts array from current contract storage in the exact same order
        // as when requestDecryption was called. Re-calculate the hash and compare it with the stored stateHash.
        // This ensures that the contract state relevant to this decryption request has not changed.
        euint32 memory currentEncryptedUses = agentStats[agentStatsForAgentId].encryptedTotalUses; // Placeholder for actual retrieval
        euint32 memory currentEncryptedRevenue = agentStats[agentStatsForAgentId].encryptedTotalRevenue; // Placeholder

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = FHE.toBytes32(currentEncryptedUses);
        currentCts[1] = FHE.toBytes32(currentEncryptedRevenue);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        // @dev Proof Verification: Verify the proof of correct decryption.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // Decode cleartexts in the same order they were submitted for decryption
        uint32 totalUses = abi.decode(cleartexts.slice(0, 4), (uint32));
        uint32 totalRevenue = abi.decode(cleartexts.slice(4, 4), (uint32));

        decryptionContexts[requestId].processed = true;

        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalUses, totalRevenue);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(uint256 agentId) internal {
        if (!FHE.isInitialized(agentStats[agentId].encryptedTotalUses)) {
            agentStats[agentId].encryptedTotalUses = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(agentStats[agentId].encryptedTotalRevenue)) {
            agentStats[agentId].encryptedTotalRevenue = FHE.asEuint32(0);
        }
    }
}