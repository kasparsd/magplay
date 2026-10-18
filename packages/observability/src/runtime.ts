import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { Counter, Gauge, Histogram } from '@prometheus-io/client'
import type { Registry } from '@prometheus-io/client'

/** Explicitly owned equivalents of the standard runtime metrics: the client's
 * default collector does not expose teardown for its perf_hooks observers. */
export function collectRuntime (registry: Registry): () => void {
  const registers = [registry]
  let previous = process.cpuUsage()
  registry.registerMetric(new Counter({
    name: 'process_cpu_seconds_total',
    help: 'Node CPU seconds since instrumentation started (excludes ffmpeg)',
    registers,
    collect () {
      const cpu = process.cpuUsage()
      this.inc(Math.max(0, cpu.user + cpu.system - previous.user - previous.system) / 1e6)
      previous = cpu
    }
  }))
  registry.registerMetric(new Gauge({ name: 'process_resident_memory_bytes', help: 'Node resident memory', registers, collect () { this.set(process.memoryUsage().rss) } }))
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  registry.registerMetric(new Gauge({
    name: 'nodejs_eventloop_lag_p99_seconds',
    help: 'Event loop p99 delay since previous scrape',
    registers,
    collect () {
      if (delay.count > 0) this.set(delay.percentile(99) / 1e9)
      delay.reset()
    }
  }))
  const gc = new Histogram({ name: 'nodejs_gc_duration_seconds', help: 'Node garbage collection duration', registers, buckets: [0.001, 0.01, 0.1, 1] })
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) gc.observe(entry.duration / 1000) })
  observer.observe({ entryTypes: ['gc'] })
  return () => { delay.disable(); observer.disconnect() }
}
