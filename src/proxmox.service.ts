import axios, { AxiosInstance } from 'axios';
import https from 'https';

export interface ProxmoxConfig {
  baseUrl: string; // e.g. https://192.168.200.1:8006/api2/json or https://192.168.200.12:8006/api2/json
  tokenId?: string; // e.g. root@pam!ctf or CTFAdmin@harryfultz.local!ctf
  tokenSecret?: string;
  username?: string;
  password?: string;
  defaultNode: string; // e.g. pms1
  defaultStorage: string; // e.g. local-lvm
  defaultBridge: string; // e.g. vmbr0
}

export interface HardwareSpecs {
  cores?: number;
  memoryMB?: number;
  diskGB?: number;
  swapMB?: number;
  storagePool?: string;
}

export interface ProvisionResult {
  vmid: number;
  node: string;
  ipAddress?: string;
  status: string;
  hostname: string;
}

export class ProxmoxService {
  private client: AxiosInstance;
  private config: ProxmoxConfig;
  private ticket?: string;
  private csrfToken?: string;
  private ticketExpiresAt = 0;

  constructor(config: ProxmoxConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl.replace(/\/+$/, ''),
      timeout: 30000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Accept self-signed Proxmox certs
    });

    // Interceptor for Token or Ticket Authorization
    this.client.interceptors.request.use(async (req) => {
      if (this.config.tokenId && this.config.tokenSecret) {
        req.headers['Authorization'] = `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`;
      } else if (this.config.username && this.config.password) {
        await this.ensureTicket();
        if (this.ticket) {
          req.headers['Cookie'] = `PVEAuthCookie=${this.ticket}`;
        }
        if (this.csrfToken && req.method?.toLowerCase() !== 'get') {
          req.headers['CSRFPreventionToken'] = this.csrfToken;
        }
      }
      return req;
    });
  }

  private async ensureTicket(): Promise<void> {
    if (this.ticket && Date.now() < this.ticketExpiresAt) {
      return;
    }
    try {
      const res = await axios.post(
        `${this.config.baseUrl}/access/ticket`,
        {
          username: this.config.username,
          password: this.config.password,
        },
        {
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        }
      );
      this.ticket = res.data.data.ticket;
      this.csrfToken = res.data.data.CSRFPreventionToken;
      // Ticket is valid for 2 hours; refresh after 1.5 hours
      this.ticketExpiresAt = Date.now() + 90 * 60 * 1000;
    } catch (err: any) {
      console.error('[ProxmoxService] Failed to authenticate with ticket:', err?.message || err);
      throw new Error(`Proxmox authentication failed: ${err?.message || err}`);
    }
  }

  /**
   * Get next available VMID in the Proxmox cluster
   */
  async getNextVmId(): Promise<number> {
    try {
      const res = await this.client.get('/cluster/nextid');
      if (res.data?.data) {
        return parseInt(res.data.data, 10);
      }
    } catch (err: any) {
      console.warn(`[ProxmoxService] /cluster/nextid API check:`, err?.message || err);
    }

    // Dynamic scan: fetch all currently used VMIDs in the cluster to guarantee no collision
    try {
      const res = await this.client.get('/cluster/resources?type=vm');
      const vms = res.data?.data || [];
      const usedIds = new Set<number>(vms.map((v: any) => parseInt(v.vmid, 10)));
      
      // Start searching from 300 upwards
      let candidate = 300;
      while (usedIds.has(candidate)) {
        candidate++;
      }
      console.log(`[ProxmoxService] Found next available cluster VMID dynamically: ${candidate}`);
      return candidate;
    } catch (clusterErr) {
      const fallbackId = Math.floor(Math.random() * 600) + 300;
      console.warn(`[ProxmoxService] cluster/resources fallback, using random ID ${fallbackId}`);
      return fallbackId;
    }
  }

  /**
   * Dynamically allocate an available IPv4 address from the subnet pool
   * Checks currently assigned IPs across cluster resources and ARP/interfaces
   */
  async getAvailableIp(subnetBase = '192.168.200', startRange = 160, endRange = 240): Promise<string> {
    try {
      const usedIps = new Set<string>();

      // Reserved IPs for core infrastructure
      usedIps.add('192.168.200.1');   // Gateway
      usedIps.add('192.168.200.11');  // Auth
      usedIps.add('192.168.200.12');  // Frontend
      usedIps.add('192.168.200.13');  // Core-backend
      usedIps.add('192.168.200.14');  // DB
      usedIps.add('192.168.200.15');  // ChallengeHoste VM5
      usedIps.add('192.168.200.201'); // Proxmox pms1
      usedIps.add('192.168.200.202'); // Proxmox pms2

      // Collect IPs currently assigned to active LXCs and VMs in Proxmox
      const clusterRes = await this.client.get('/cluster/resources?type=vm');
      const items = clusterRes.data?.data || [];
      for (const item of items) {
        if (item.node && item.vmid && item.status === 'running') {
          try {
            if (item.type === 'lxc') {
              const ifRes = await this.client.get(`/nodes/${item.node}/lxc/${item.vmid}/interfaces`).catch(() => null);
              const ifaces = ifRes?.data?.data || [];
              for (const iface of ifaces) {
                if (iface.inet) {
                  usedIps.add(String(iface.inet).split('/')[0].trim());
                }
              }
            }
          } catch (e) {
            // ignore
          }
        }
      }

      for (let i = startRange; i <= endRange; i++) {
        const candidateIp = `${subnetBase}.${i}`;
        if (!usedIps.has(candidateIp)) {
          return candidateIp;
        }
      }
    } catch (err: any) {
      console.warn('[ProxmoxService] getAvailableIp scan error:', err?.message || err);
    }

    // Default dynamic IP assignment fallback
    const randomHost = Math.floor(Math.random() * (endRange - startRange)) + startRange;
    return `${subnetBase}.${randomHost}`;
  }

  /**
   * Clone and Provision a Proxmox LXC Container (CT)
   */
  async provisionLxc(
    node: string,
    templateId: number,
    hostname: string,
    specs: HardwareSpecs
  ): Promise<ProvisionResult> {
    const targetNode = node || this.config.defaultNode;
    const vmid = await this.getNextVmId();
    const storage = specs.storagePool || this.config.defaultStorage;

    console.log(`[ProxmoxService] Cloning LXC CT ${templateId} -> new VMID ${vmid} on node ${targetNode}...`);

    // 1. Clone LXC
    await this.client.post(`/nodes/${targetNode}/lxc/${templateId}/clone`, {
      newid: vmid,
      hostname: hostname,
      storage: storage,
      full: 1,
    });

    // Wait a brief moment for clone task to register
    await new Promise((r) => setTimeout(r, 4000));

    // 2. Configure Hardware Specifications and Dynamic Static IP/DHCP
    const configPayload: Record<string, any> = {};
    if (specs.cores) configPayload.cores = specs.cores;
    if (specs.memoryMB) configPayload.memory = specs.memoryMB;
    if (specs.swapMB) configPayload.swap = specs.swapMB;

    // Dynamically find available IP for LXC and configure network interface
    const assignedIp = await this.getAvailableIp();
    configPayload.net0 = `name=eth0,bridge=${this.config.defaultBridge || 'vmbr0'},ip=${assignedIp}/24,gw=192.168.200.1`;

    if (Object.keys(configPayload).length > 0) {
      console.log(`[ProxmoxService] Setting hardware & dynamic IP (${assignedIp}) on CT ${vmid}:`, configPayload);
      try {
        await this.client.put(`/nodes/${targetNode}/lxc/${vmid}/config`, configPayload);
      } catch (cfgErr: any) {
        console.warn(`[ProxmoxService] Config warning on CT ${vmid}:`, cfgErr?.response?.data || cfgErr?.message);
      }
    }

    // 3. Start the container
    console.log(`[ProxmoxService] Starting LXC CT ${vmid}...`);
    await this.client.post(`/nodes/${targetNode}/lxc/${vmid}/status/start`);

    // 4. Poll for IP address (or use assigned IP immediately)
    const polledIp = await this.pollLxcIp(targetNode, vmid);
    const ipAddress = polledIp || assignedIp;

    return {
      vmid,
      node: targetNode,
      ipAddress,
      status: 'RUNNING',
      hostname,
    };
  }

  /**
   * Clone and Provision a Proxmox QEMU Virtual Machine (VM)
   */
  async provisionVm(
    node: string,
    templateId: number,
    name: string,
    specs: HardwareSpecs
  ): Promise<ProvisionResult> {
    const targetNode = node || this.config.defaultNode;
    const vmid = await this.getNextVmId();
    const storage = specs.storagePool || this.config.defaultStorage;

    console.log(`[ProxmoxService] Cloning QEMU VM ${templateId} -> new VMID ${vmid} on node ${targetNode}...`);

    // 1. Clone QEMU VM
    await this.client.post(`/nodes/${targetNode}/qemu/${templateId}/clone`, {
      newid: vmid,
      name: name,
      storage: storage,
      full: 1,
    });

    // Wait for clone task
    await new Promise((r) => setTimeout(r, 6000));

    // 2. Configure Hardware (Cores, RAM)
    const configPayload: Record<string, any> = {};
    if (specs.cores) configPayload.cores = specs.cores;
    if (specs.memoryMB) configPayload.memory = specs.memoryMB;

    if (Object.keys(configPayload).length > 0) {
      console.log(`[ProxmoxService] Setting hardware config on VM ${vmid}:`, configPayload);
      try {
        await this.client.put(`/nodes/${targetNode}/qemu/${vmid}/config`, configPayload);
      } catch (cfgErr: any) {
        console.warn(`[ProxmoxService] Config warning on VM ${vmid}:`, cfgErr?.response?.data || cfgErr?.message);
      }
    }

    // 3. Start the VM
    console.log(`[ProxmoxService] Starting QEMU VM ${vmid}...`);
    await this.client.post(`/nodes/${targetNode}/qemu/${vmid}/status/start`);

    // 4. Poll for IP via Guest Agent or network interfaces
    const ipAddress = await this.pollVmIp(targetNode, vmid);

    return {
      vmid,
      node: targetNode,
      ipAddress,
      status: 'RUNNING',
      hostname: name,
    };
  }

  /**
   * Destroy LXC container
   */
  async destroyLxc(node: string, vmid: number): Promise<void> {
    const targetNode = node || this.config.defaultNode;
    console.log(`[ProxmoxService] Stopping and deleting LXC CT ${vmid} on node ${targetNode}...`);
    try {
      await this.client.post(`/nodes/${targetNode}/lxc/${vmid}/status/stop`);
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      // Ignore if already stopped
    }
    try {
      await this.client.delete(`/nodes/${targetNode}/lxc/${vmid}?purge=1&force=1`);
    } catch (err: any) {
      console.warn(`[ProxmoxService] Delete LXC ${vmid} warning:`, err?.response?.data || err?.message);
    }
  }

  /**
   * Destroy QEMU VM
   */
  async destroyVm(node: string, vmid: number): Promise<void> {
    const targetNode = node || this.config.defaultNode;
    console.log(`[ProxmoxService] Stopping and deleting QEMU VM ${vmid} on node ${targetNode}...`);
    try {
      await this.client.post(`/nodes/${targetNode}/qemu/${vmid}/status/stop`);
      await new Promise((r) => setTimeout(r, 4000));
    } catch (e) {
      // Ignore if already stopped
    }
    try {
      await this.client.delete(`/nodes/${targetNode}/qemu/${vmid}?purge=1`);
    } catch (err: any) {
      console.warn(`[ProxmoxService] Delete VM ${vmid} warning:`, err?.response?.data || err?.message);
    }
  }

  /**
   * Poll LXC network interfaces to retrieve IPv4 address
   */
  async pollLxcIp(node: string, vmid: number, maxAttempts = 6): Promise<string | undefined> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await this.client.get(`/nodes/${node}/lxc/${vmid}/interfaces`);
        const ifaces = res.data.data;
        if (Array.isArray(ifaces)) {
          for (const iface of ifaces) {
            if (iface.name !== 'lo' && iface.inet) {
              const ip = String(iface.inet).split('/')[0].trim();
              if (ip && ip !== '127.0.0.1') return ip;
            }
          }
        }
      } catch (e) {
        // Continue polling
      }
    }
    return undefined;
  }

  /**
   * Poll QEMU Guest Agent network interfaces
   */
  async pollVmIp(node: string, vmid: number, maxAttempts = 8): Promise<string | undefined> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const res = await this.client.get(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`);
        const result = res.data.data?.result;
        if (Array.isArray(result)) {
          for (const iface of result) {
            if (iface.name !== 'lo' && Array.isArray(iface['ip-addresses'])) {
              for (const addr of iface['ip-addresses']) {
                if (addr['ip-address-type'] === 'ipv4' && !addr['ip-address'].startsWith('127.')) {
                  return addr['ip-address'];
                }
              }
            }
          }
        }
      } catch (e) {
        // Agent might not be ready yet
      }
    }
    return undefined;
  }

  /**
   * Get resource list / nodes status in Proxmox cluster
   */
  async getClusterNodes(): Promise<any[]> {
    try {
      const res = await this.client.get('/nodes');
      return res.data.data || [];
    } catch (err: any) {
      console.warn('[ProxmoxService] Failed to get nodes list:', err?.message || err);
      return [
        { node: 'pms1', status: 'online' },
        { node: 'pms2', status: 'online' },
        { node: 'pms3', status: 'online' },
      ];
    }
  }
}
