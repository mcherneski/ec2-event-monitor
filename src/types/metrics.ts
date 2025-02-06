export interface WebsocketMetrics {
  connected: boolean;
  lastReconnectAttempt: number;
  reconnectAttempts: number;
  messagesProcessed: number;
  circuitBreakerOpen: boolean;
} 