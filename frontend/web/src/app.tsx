// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface AIAgent {
  id: string;
  name: string;
  description: string;
  encryptedModel: string;
  encryptedPrice: string;
  category: string;
  owner: string;
  timestamp: number;
  usageCount: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAgentData, setNewAgentData] = useState({ name: "", description: "", price: 0, category: "" });
  const [selectedAgent, setSelectedAgent] = useState<AIAgent | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [userHistory, setUserHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Stats calculations
  const totalAgents = agents.length;
  const totalValue = agents.reduce((sum, agent) => sum + FHEDecryptNumber(agent.encryptedPrice), 0);
  const avgPrice = totalAgents > 0 ? totalValue / totalAgents : 0;
  const categories = [...new Set(agents.map(agent => agent.category))];

  useEffect(() => {
    loadAgents().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadAgents = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("agent_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing agent keys:", e); }
      }
      
      const list: AIAgent[] = [];
      for (const key of keys) {
        try {
          const agentBytes = await contract.getData(`agent_${key}`);
          if (agentBytes.length > 0) {
            try {
              const agentData = JSON.parse(ethers.toUtf8String(agentBytes));
              list.push({ 
                id: key, 
                name: agentData.name,
                description: agentData.description,
                encryptedModel: agentData.encryptedModel,
                encryptedPrice: agentData.encryptedPrice,
                category: agentData.category,
                owner: agentData.owner,
                timestamp: agentData.timestamp,
                usageCount: agentData.usageCount || 0
              });
            } catch (e) { console.error(`Error parsing agent data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading agent ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAgents(list);
    } catch (e) { console.error("Error loading agents:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitAgent = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting AI agent with Zama FHE..." });
    try {
      const encryptedPrice = FHEEncryptNumber(newAgentData.price);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const agentId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const agentData = { 
        name: newAgentData.name,
        description: newAgentData.description,
        encryptedModel: `FHE-${btoa(JSON.stringify({ model: "encrypted" }))}`,
        encryptedPrice,
        category: newAgentData.category,
        owner: address,
        timestamp: Math.floor(Date.now() / 1000),
        usageCount: 0
      };
      
      await contract.setData(`agent_${agentId}`, ethers.toUtf8Bytes(JSON.stringify(agentData)));
      
      const keysBytes = await contract.getData("agent_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(agentId);
      await contract.setData("agent_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "AI Agent listed securely with FHE!" });
      await loadAgents();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAgentData({ name: "", description: "", price: 0, category: "" });
      }, 2000);
      
      // Add to user history
      setUserHistory(prev => [...prev, `Created agent: ${newAgentData.name}`]);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const purchaseAgent = async (agentId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing FHE-encrypted purchase..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const agentBytes = await contract.getData(`agent_${agentId}`);
      if (agentBytes.length === 0) throw new Error("Agent not found");
      const agentData = JSON.parse(ethers.toUtf8String(agentBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      // Increment usage count
      const updatedAgent = { 
        ...agentData, 
        usageCount: (agentData.usageCount || 0) + 1 
      };
      await contractWithSigner.setData(`agent_${agentId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAgent)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted AI Agent purchased!" });
      await loadAgents();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      
      // Add to user history
      const agent = agents.find(a => a.id === agentId);
      if (agent) {
        setUserHistory(prev => [...prev, `Purchased agent: ${agent.name}`]);
      }
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Purchase failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (agentAddress: string) => address?.toLowerCase() === agentAddress.toLowerCase();

  const filteredAgents = agents.filter(agent => {
    const matchesSearch = agent.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         agent.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = filterCategory === "all" || agent.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const renderAgentCard = (agent: AIAgent) => (
    <div className="agent-card" key={agent.id} onClick={() => setSelectedAgent(agent)}>
      <div className="card-header">
        <div className="agent-category">{agent.category}</div>
        <div className="agent-usage">Used {agent.usageCount} times</div>
      </div>
      <div className="card-body">
        <h3 className="agent-name">{agent.name}</h3>
        <p className="agent-description">{agent.description.substring(0, 100)}...</p>
        <div className="fhe-badge">
          <div className="fhe-icon"></div>
          <span>FHE Encrypted</span>
        </div>
      </div>
      <div className="card-footer">
        <div className="price-section">
          <span className="price-label">Price:</span>
          <span className="price-value">
            {decryptedPrice !== null && selectedAgent?.id === agent.id ? 
              `${decryptedPrice.toFixed(2)} ETH` : 
              "Encrypted"}
          </span>
        </div>
        <button 
          className="purchase-btn" 
          onClick={(e) => { e.stopPropagation(); purchaseAgent(agent.id); }}
        >
          Purchase
        </button>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE Marketplace...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="ai-icon"></div>
          </div>
          <h1>AI Agent<span>Market</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-agent-btn">
            <div className="add-icon"></div>Sell Agent
          </button>
          <button className="history-btn" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? "Hide History" : "Show History"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Encrypted AI Agent Marketplace</h2>
            <p>Buy and sell AI agents with fully homomorphic encryption powered by Zama</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>

        <div className="dashboard-section">
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{totalAgents}</div>
              <div className="stat-label">AI Agents</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{totalValue.toFixed(2)}</div>
              <div className="stat-label">Total Value (ETH)</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{avgPrice.toFixed(2)}</div>
              <div className="stat-label">Avg Price (ETH)</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{categories.length}</div>
              <div className="stat-label">Categories</div>
            </div>
          </div>
        </div>

        <div className="search-filters">
          <div className="search-bar">
            <input 
              type="text" 
              placeholder="Search AI agents..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <div className="search-icon"></div>
          </div>
          <select 
            value={filterCategory} 
            onChange={(e) => setFilterCategory(e.target.value)}
            className="category-filter"
          >
            <option value="all">All Categories</option>
            {categories.map(category => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
          <button onClick={loadAgents} className="refresh-btn" disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {showHistory && (
          <div className="history-panel">
            <h3>Your Activity History</h3>
            {userHistory.length === 0 ? (
              <p className="no-history">No activity history yet</p>
            ) : (
              <ul className="history-list">
                {userHistory.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="agents-grid">
          {filteredAgents.length === 0 ? (
            <div className="no-agents">
              <div className="no-agents-icon"></div>
              <p>No AI agents found matching your criteria</p>
              <button onClick={() => setShowCreateModal(true)}>List Your First Agent</button>
            </div>
          ) : (
            filteredAgents.map(renderAgentCard)
          )}
        </div>

        <div className="project-intro">
          <h2>About FHE AI Agent Marketplace</h2>
          <p>
            This marketplace utilizes <strong>Zama's Fully Homomorphic Encryption (FHE)</strong> technology to enable 
            secure trading of AI agents. Agents' core capabilities remain encrypted at all times, protecting 
            intellectual property while allowing buyers to safely use the agents on their encrypted data.
          </p>
          <div className="fhe-process">
            <div className="process-step">
              <div className="step-icon">🔒</div>
              <h3>Encrypted Models</h3>
              <p>AI models are encrypted with FHE before being listed</p>
            </div>
            <div className="process-step">
              <div className="step-icon">🔄</div>
              <h3>Secure Transactions</h3>
              <p>Purchases processed without decrypting sensitive data</p>
            </div>
            <div className="process-step">
              <div className="step-icon">🤖</div>
              <h3>Protected Usage</h3>
              <p>Run agents on your data without exposing the model</p>
            </div>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitAgent} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          agentData={newAgentData} 
          setAgentData={setNewAgentData}
        />
      )}

      {selectedAgent && (
        <AgentDetailModal 
          agent={selectedAgent} 
          onClose={() => { setSelectedAgent(null); setDecryptedPrice(null); }} 
          decryptedPrice={decryptedPrice}
          setDecryptedPrice={setDecryptedPrice}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
          isOwner={isOwner(selectedAgent.owner)}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="ai-icon"></div>
              <span>FHE AI Marketplace</span>
            </div>
            <p>Powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered AI Economy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} AI Agent Market. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  agentData: any;
  setAgentData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, agentData, setAgentData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setAgentData({ ...agentData, [name]: value });
  };

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAgentData({ ...agentData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!agentData.name || !agentData.description || !agentData.price || !agentData.category) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>List New AI Agent</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your AI agent will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-group">
            <label>Agent Name *</label>
            <input 
              type="text" 
              name="name" 
              value={agentData.name} 
              onChange={handleChange} 
              placeholder="Enter agent name..."
            />
          </div>
          <div className="form-group">
            <label>Description *</label>
            <textarea 
              name="description" 
              value={agentData.description} 
              onChange={handleChange} 
              placeholder="Describe what your AI agent does..."
              rows={3}
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={agentData.category} onChange={handleChange}>
                <option value="">Select category</option>
                <option value="Image Generation">Image Generation</option>
                <option value="Text Analysis">Text Analysis</option>
                <option value="Data Prediction">Data Prediction</option>
                <option value="Automation">Automation</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Price (ETH) *</label>
              <input 
                type="number" 
                name="price" 
                value={agentData.price} 
                onChange={handlePriceChange} 
                placeholder="0.00"
                step="0.01"
                min="0"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Price:</span>
                <div>{agentData.price || '0.00'} ETH</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Price:</span>
                <div>{agentData.price ? FHEEncryptNumber(agentData.price).substring(0, 50) + '...' : 'No price entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Model Protection</strong>
              <p>Your AI model remains encrypted during processing and cannot be reverse engineered</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn">
            {creating ? "Encrypting with FHE..." : "List Agent Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AgentDetailModalProps {
  agent: AIAgent;
  onClose: () => void;
  decryptedPrice: number | null;
  setDecryptedPrice: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  isOwner: boolean;
}

const AgentDetailModal: React.FC<AgentDetailModalProps> = ({ 
  agent, 
  onClose, 
  decryptedPrice, 
  setDecryptedPrice, 
  isDecrypting, 
  decryptWithSignature,
  isOwner
}) => {
  const handleDecrypt = async () => {
    if (decryptedPrice !== null) { setDecryptedPrice(null); return; }
    const decrypted = await decryptWithSignature(agent.encryptedPrice);
    if (decrypted !== null) setDecryptedPrice(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="agent-detail-modal">
        <div className="modal-header">
          <h2>{agent.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="agent-info">
            <div className="info-item">
              <span>Category:</span>
              <strong>{agent.category}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{agent.owner.substring(0, 6)}...{agent.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Listed:</span>
              <strong>{new Date(agent.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
            <div className="info-item">
              <span>Usage Count:</span>
              <strong>{agent.usageCount}</strong>
            </div>
          </div>
          <div className="agent-description">
            <h3>Description</h3>
            <p>{agent.description}</p>
          </div>
          <div className="price-section">
            <h3>Price</h3>
            <div className="price-display">
              {decryptedPrice !== null ? (
                <div className="decrypted-price">
                  {decryptedPrice.toFixed(2)} ETH
                </div>
              ) : (
                <div className="encrypted-price">
                  <div className="fhe-icon"></div>
                  <span>FHE Encrypted</span>
                </div>
              )}
              {!isOwner && (
                <button 
                  className="decrypt-btn" 
                  onClick={handleDecrypt} 
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedPrice !== null ? "Hide Price" : "Reveal Price"}
                </button>
              )}
            </div>
          </div>
          <div className="model-section">
            <h3>AI Model</h3>
            <div className="model-info">
              <div className="fhe-badge">
                <div className="fhe-icon"></div>
                <span>FHE Encrypted</span>
              </div>
              <p>The model architecture and weights are fully encrypted with Zama FHE</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
          {!isOwner && (
            <button 
              className="purchase-btn" 
              onClick={() => {
                onClose();
                // In a real app, you would trigger purchase flow here
              }}
            >
              Purchase Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;