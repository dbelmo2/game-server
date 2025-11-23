export interface PoolItem<T> {
    data: T;
    free: boolean;
}

export interface PoolStats {
    total: number;
    free: number;
    inUse: number;
}
class ObjectPool<T> {
    #poolArray: PoolItem<T>[] = []; // Private array to hold the pooled objects
    #objectToIndex: Map<T, number> = new Map(); // Fast lookup for release operations
    #constructorFunction: () => T;
    #resetFunction: (obj: T) => T;
    #destroyFunction: (obj: T) => void;
    #maxSize: number;

    constructor(
        constructorFunction: () => T,
        resetFunction: (obj: T) => T = (obj) => obj,
        destroyFunction: (obj: T) => void = (obj) => {},
        initialSize: number = 10,
        maxSize: number = 1000
    ) {
        this.#constructorFunction = constructorFunction;
        this.#resetFunction = resetFunction;
        this.#destroyFunction = destroyFunction;
        this.#maxSize = maxSize;

        // Initialize the pool with a set number of objects
        for (let i = 0; i < initialSize; i++) {
            const obj = this.#constructorFunction();
            this.#poolArray.push({
                data: obj,
                free: true
            });
            this.#objectToIndex.set(obj, i);
        }
    }

    // Method to get an object from the pool
    getElement(): T {
        for (let i = 0; i < this.#poolArray.length; i++) {
            if (this.#poolArray[i].free) {
                this.#poolArray[i].free = false;
                // Return the object directly - it was already reset when released
                return this.#poolArray[i].data;
            }
        }

        // If no free objects are available, create a new one if under max size
        if (this.#poolArray.length >= this.#maxSize) {
            console.warn("Pool at maximum capacity, reusing oldest object");
            // Reuse the first object in the pool as a fallback
            this.#poolArray[0].free = false;
            // Reset the reused object since it wasn't properly released
            return this.#resetFunction(this.#poolArray[0].data);
        }

        const newObject = this.#constructorFunction();
        const newIndex = this.#poolArray.length;
        this.#poolArray.push({
            data: newObject,
            free: false
        });
        this.#objectToIndex.set(newObject, newIndex);
        return newObject;
    }

    // Method to return an object to the pool
    releaseElement(element: T): void {
        const index = this.#objectToIndex.get(element);
        
        if (index !== undefined && index < this.#poolArray.length) {
            this.#resetFunction(element);
            this.#poolArray[index].free = true;
            return;
        }
        
        console.warn("Attempted to release an object not belonging to this pool.");
    }

    // Get pool statistics for debugging/monitoring
    getPoolStats(): PoolStats {
        const free = this.#poolArray.filter(item => item.free).length;
        return {
            total: this.#poolArray.length,
            free: free,
            inUse: this.#poolArray.length - free
        };
    }

    // Optional: Method to clear and reset the entire pool
    clear(): void {
        for (let i = 0; i < this.#poolArray.length; i++) {
            // Reset each object before marking it as free
            this.#resetFunction(this.#poolArray[i].data);
            this.#poolArray[i].free = true;
        }
    }


    // Complete cleanup method for session end
    destroy(): void {
        // Destroy all objects first
        for (let item of this.#poolArray) {
            this.#destroyFunction(item.data);
        }
        
        // Clear all references and empty the pool
        this.#poolArray.length = 0;
        this.#objectToIndex.clear();
    }
}

export default ObjectPool;