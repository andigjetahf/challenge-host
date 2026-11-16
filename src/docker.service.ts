import Docker from 'dockerode';

export interface DockerSpawnOptions {
  image: string;
  containerName: string;
  internalPort: number;
  subdomain: string;
  ctfDomain: string;
  traefikNetwork: string;
  cpuQuota?: number;
  memoryLimitMB?: number;
}

export class DockerService {
  private docker: Docker;

  constructor(socketPath = '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath });
  }

  async ensureImage(image: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (followErr: Error | null) => {
          if (followErr) return reject(followErr);
          resolve();
        });
      });
    });
  }

  async spawnContainer(opts: DockerSpawnOptions): Promise<{ containerId: string; hostUrl: string }> {
    const { image, containerName, internalPort, subdomain, ctfDomain, traefikNetwork } = opts;
    const hostUrl = `http://${subdomain}.${ctfDomain}`;

    const labels: Record<string, string> = {
      'traefik.enable': 'true',
      [`traefik.http.routers.${containerName}.rule`]: `Host(\`${subdomain}.${ctfDomain}\`)`,
      [`traefik.http.routers.${containerName}.entrypoints`]: 'web',
      [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(internalPort),
      'traefik.docker.network': traefikNetwork,
    };

    const container = await this.docker.createContainer({
      Image: image,
      name: containerName,
      Labels: labels,
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: (opts.memoryLimitMB || 512) * 1024 * 1024,
        CpuQuota: opts.cpuQuota || 50000,
        NetworkMode: traefikNetwork,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [traefikNetwork]: {},
        },
      },
    });

    await container.start();
    const info = await container.inspect();
    return { containerId: info.Id, hostUrl };
  }

  async destroyContainer(containerIdOrName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerIdOrName);
      try {
        await container.stop({ t: 5 });
      } catch (e) {
        // already stopped
      }
      await container.remove({ force: true });
    } catch (err: any) {
      if (!err?.message?.includes('No such container')) {
        console.warn(`[DockerService] Error destroying container ${containerIdOrName}:`, err?.message);
      }
    }
  }
}
