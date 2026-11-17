import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ProxmoxService } from './proxmox.service';
import { DockerService } from './docker.service';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5050;

app.use(cors());
app.use(express.json());

// Proxmox Service Instance
const proxmox = new ProxmoxService({
  baseUrl: process.env.PROXMOX_API_URL || 'https://192.168.200.201:8006/api2/json',
  tokenId: process.env.PROXMOX_TOKEN_ID,
  tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
  username: process.env.PROXMOX_USERNAME || 'root@pam',
  password: process.env.PROXMOX_PASSWORD,
  defaultNode: process.env.PROXMOX_DEFAULT_NODE || 'pms1',
  defaultStorage: process.env.PROXMOX_DEFAULT_STORAGE || 'local-lvm',
  defaultBridge: process.env.PROXMOX_DEFAULT_BRIDGE || 'vmbr0',
});

// Docker Service Instance
const docker = new DockerService(process.env.DOCKER_SOCKET || '/var/run/docker.sock');

const ctfDomain = process.env.CTF_DOMAIN || 'ctf.local';
const traefikNetwork = process.env.TRAEFIK_NETWORK || 'traefik_net';

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'challenge-host-orchestrator' });
});

/**
 * Get Proxmox Cluster Nodes (pms1, pms2, pms3)
 */
app.get('/api/nodes', async (_req: Request, res: Response) => {
  try {
    const nodes = await proxmox.getClusterNodes();
    res.status(200).json(nodes);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch cluster nodes', details: err?.message });
  }
});

/**
 * Main Provisioning Endpoint:
 * ChallengeHoste is responsible for provisioning instances in Proxmox or Docker!
 */
app.post('/api/provision', async (req: Request, res: Response) => {
  try {
    const { userId, username, challenge } = req.body;

    if (!challenge) {
      res.status(400).json({ error: 'Missing challenge specification' });
      return;
    }

    const runtimeType = challenge.runtimeType || 'PROXMOX_CT';
    const targetNode = challenge.proxmoxNode || process.env.PROXMOX_DEFAULT_NODE || 'pms1';
    const templateId = challenge.templateId ? parseInt(challenge.templateId, 10) : 101;
    // Add random 4-char suffix so recreations or parallel runs never collide on subdomain/containerName
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const rawSubdomain = `${username || 'user'}-${(challenge.slug || challenge.id).slice(0, 8)}-${randomSuffix}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    const containerName = `ctf-${rawSubdomain}`;

    console.log(`[ChallengeHoste] Provisioning request for ${username} (Runtime: ${runtimeType}, Node: ${targetNode})...`);

    // ==========================================
    // 1. PROXMOX LXC CONTAINER PROVISIONING
    // ==========================================
    if (runtimeType === 'PROXMOX_CT') {
      const result = await proxmox.provisionLxc(
        targetNode,
        templateId,
        containerName,
        {
          cores: challenge.cpuCores || 1,
          memoryMB: challenge.ramMB || 1024,
          diskGB: challenge.diskGB || 8,
          storagePool: challenge.storagePool || 'local-lvm',
        }
      );

      const internalPort = challenge.internalPort || 3000;
      const targetIp = result.ipAddress || `${targetNode}.ctf.local`;
      const isHttp = challenge.connectionType !== 'SSH' && challenge.connectionType !== 'TCP';

      const hostUrl = isHttp
        ? (result.ipAddress ? `http://${result.ipAddress}:${internalPort}` : `http://${rawSubdomain}.${ctfDomain}`)
        : `ssh student@${targetIp}`;

      const connectionUrl = challenge.connectionType === 'SSH'
        ? `ssh student@${targetIp}`
        : hostUrl;

      res.status(200).json({
        success: true,
        runtimeType: 'PROXMOX_CT',
        vmid: result.vmid,
        proxmoxNode: result.node,
        ipAddress: result.ipAddress || null,
        hostUrl,
        connectionUrl,
        containerId: `ct-${result.node}-${result.vmid}`,
        containerName,
        subdomain: rawSubdomain,
        internalPort,
      });
      return;
    }

    // ==========================================
    // 2. PROXMOX QEMU VM PROVISIONING
    // ==========================================
    if (runtimeType === 'PROXMOX_VM') {
      const result = await proxmox.provisionVm(
        targetNode,
        templateId,
        containerName,
        {
          cores: challenge.cpuCores || 2,
          memoryMB: challenge.ramMB || 2048,
          diskGB: challenge.diskGB || 20,
          storagePool: challenge.storagePool || 'local-lvm',
        }
      );

      const internalPort = challenge.internalPort || 80;
      const targetIp = result.ipAddress || `${targetNode}.ctf.local`;
      const isHttp = challenge.connectionType !== 'SSH';

      const hostUrl = isHttp
        ? (result.ipAddress ? `http://${result.ipAddress}:${internalPort}` : `http://${rawSubdomain}.${ctfDomain}`)
        : `ssh student@${targetIp}`;

      const connectionUrl = challenge.connectionType === 'SSH'
        ? `ssh student@${targetIp}`
        : hostUrl;

      res.status(200).json({
        success: true,
        runtimeType: 'PROXMOX_VM',
        vmid: result.vmid,
        proxmoxNode: result.node,
        ipAddress: result.ipAddress || null,
        hostUrl,
        connectionUrl,
        containerId: `vm-${result.node}-${result.vmid}`,
        containerName,
        subdomain: rawSubdomain,
        internalPort,
      });
      return;
    }

    // ==========================================
    // 3. DOCKER FALLBACK PROVISIONING
    // ==========================================
    const dockerResult = await docker.spawnContainer({
      image: challenge.dockerImage || 'bkimminich/juice-shop:v16.0.0',
      containerName,
      internalPort: challenge.internalPort || 3000,
      subdomain: rawSubdomain,
      ctfDomain,
      traefikNetwork,
      memoryLimitMB: challenge.ramMB || 512,
    });

    res.status(200).json({
      success: true,
      runtimeType: 'DOCKER',
      vmid: null,
      proxmoxNode: null,
      ipAddress: '192.168.200.15',
      hostUrl: dockerResult.hostUrl,
      connectionUrl: dockerResult.hostUrl,
      containerId: dockerResult.containerId,
      containerName,
      subdomain: rawSubdomain,
      internalPort: challenge.internalPort || 3000,
    });
  } catch (err: any) {
    console.error('[ChallengeHoste] Provisioning error:', err?.message || err);
    res.status(500).json({
      error: 'Provisioning failed on ChallengeHoste / Proxmox',
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

/**
 * Main Deprovisioning Endpoint:
 * ChallengeHoste cleans up VM / CT in Proxmox or container in Docker
 */
app.post('/api/deprovision', async (req: Request, res: Response) => {
  try {
    const { vmid, proxmoxNode, runtimeType, containerId, containerName } = req.body;

    console.log(`[ChallengeHoste] Deprovisioning request (VMID: ${vmid}, Node: ${proxmoxNode}, Type: ${runtimeType})...`);

    if (vmid && (runtimeType === 'PROXMOX_CT' || String(containerId).startsWith('ct-'))) {
      await proxmox.destroyLxc(proxmoxNode || 'pms1', parseInt(vmid, 10));
    } else if (vmid && (runtimeType === 'PROXMOX_VM' || String(containerId).startsWith('vm-'))) {
      await proxmox.destroyVm(proxmoxNode || 'pms1', parseInt(vmid, 10));
    } else if (containerId || containerName) {
      await docker.destroyContainer(containerId || containerName);
    }

    res.status(200).json({ success: true, message: 'Instance deprovisioned successfully' });
  } catch (err: any) {
    console.error('[ChallengeHoste] Deprovision error:', err?.message || err);
    res.status(500).json({ error: 'Failed to deprovision instance', details: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 [ChallengeHoste Orchestrator] Running on port ${PORT}`);
});
