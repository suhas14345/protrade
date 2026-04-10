"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskClient = exports.TaskClient = void 0;
const tasks_1 = require("@google-cloud/tasks");
class TaskClient {
    constructor() {
        this.client = new tasks_1.CloudTasksClient();
        this.project = process.env.GCLOUD_PROJECT || 'suhas-ag';
        this.location = 'us-central1';
    }
    /**
     * Internal helper for createTask with retries
     */
    async createTaskWithRetry(request, retries = 3, delay = 1000) {
        var _a, _b;
        try {
            const [response] = await this.client.createTask(request);
            return response;
        }
        catch (err) {
            const isTransient = ((_a = err.message) === null || _a === void 0 ? void 0 : _a.includes('DEADLINE_EXCEEDED')) ||
                ((_b = err.message) === null || _b === void 0 ? void 0 : _b.includes('name resolution')) ||
                err.code === 4 || // DEADLINE_EXCEEDED
                err.code === 14; // UNAVAILABLE
            if (isTransient && retries > 0) {
                console.warn(`[TaskClient] Transient error enqueuing task. Retrying in ${delay}ms... (${retries} left). Error: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.createTaskWithRetry(request, retries - 1, delay * 2);
            }
            throw err;
        }
    }
    /**
     * Enqueue a task to the Unified Gateway
     */
    async enqueue(functionName, payload, queueName) {
        const targetQueue = queueName || 'taskDispatcher';
        const parent = this.client.queuePath(this.project, this.location, targetQueue);
        // Wrap payload for the gateway
        const wrappedPayload = Object.assign(Object.assign({}, payload), { taskType: functionName });
        // Construct the task
        const task = {
            httpRequest: {
                httpMethod: 'POST',
                url: `https://${this.location}-${this.project}.cloudfunctions.net/gateway`,
                body: Buffer.from(JSON.stringify(wrappedPayload)).toString('base64'),
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
     * Enqueue a dispatch-style task to the Unified Gateway
     */
    async enqueueDispatch(queueName, payload) {
        const parent = this.client.queuePath(this.project, this.location, queueName);
        // Wrap payload for the gateway
        const wrappedPayload = Object.assign(Object.assign({}, payload), { taskType: queueName });
        const task = {
            dispatchDeadline: { seconds: 60 * 10 }, // 10 mins
            httpRequest: {
                httpMethod: 'POST',
                url: `https://${this.location}-${this.project}.cloudfunctions.net/gateway`,
                body: Buffer.from(JSON.stringify(wrappedPayload)).toString('base64'),
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
exports.TaskClient = TaskClient;
exports.taskClient = new TaskClient();
//# sourceMappingURL=tasks.js.map