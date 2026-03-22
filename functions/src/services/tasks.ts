import { CloudTasksClient } from '@google-cloud/tasks';

export class TaskClient {
  private client: CloudTasksClient;
  private project: string;
  private location: string;

  constructor() {
    this.client = new CloudTasksClient();
    this.project = process.env.GCLOUD_PROJECT || 'suhas-ag';
    this.location = 'us-central1';
  }

  /**
   * Internal helper for createTask with retries
   */
  private async createTaskWithRetry(request: any, retries = 3, delay = 1000): Promise<any> {
    try {
      const [response] = await this.client.createTask(request);
      return response;
    } catch (err: any) {
      const isTransient = err.message?.includes('DEADLINE_EXCEEDED') || 
                          err.message?.includes('name resolution') ||
                          err.code === 4 || // DEADLINE_EXCEEDED
                          err.code === 14;  // UNAVAILABLE

      if (isTransient && retries > 0) {
        console.warn(`[TaskClient] Transient error enqueuing task. Retrying in ${delay}ms... (${retries} left). Error: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.createTaskWithRetry(request, retries - 1, delay * 2);
      }
      throw err;
    }
  }

  /**
   * Enqueue a task to a specific Cloud Function (Task Queue)
   */
  async enqueue(functionName: string, payload: any) {
    const parent = this.client.queuePath(this.project, this.location, functionName);
    
    // Construct the task
    const task: any = {
      httpRequest: {
        httpMethod: 'POST',
        url: `https://${this.location}-${this.project}.cloudfunctions.net/${functionName}`,
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        headers: {
          'Content-Type': 'application/json',
        },
        oidcToken: {
          serviceAccountEmail: `${this.project}@appspot.gserviceaccount.com`,
        },
      },
    };

    return this.createTaskWithRetry({ parent, task });
  }

  /**
   * Enqueue a dispatch-style task (for onTaskDispatched functions)
   */
  async enqueueDispatch(queueName: string, payload: any) {
    const parent = this.client.queuePath(this.project, this.location, queueName);
    
    const task: any = {
      dispatchDeadline: { seconds: 60 * 10 }, // 10 mins
      httpRequest: {
        httpMethod: 'POST',
        url: `https://${this.location}-${this.project}.cloudfunctions.net/${queueName}`,
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        headers: {
          'Content-Type': 'application/json',
        },
        oidcToken: {
          serviceAccountEmail: `${this.project}@appspot.gserviceaccount.com`,
        },
      },
    };

    return this.createTaskWithRetry({ parent, task });
  }
}

export const taskClient = new TaskClient();
