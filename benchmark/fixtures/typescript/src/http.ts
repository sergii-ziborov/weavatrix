export const get = <T>(url: string): Promise<T> => apiClient.get<T>(url)
