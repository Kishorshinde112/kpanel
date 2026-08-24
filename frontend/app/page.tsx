'use client';
import { useEffect, useState } from 'react';
import axios from 'axios';

export default function Home() {
  const [data, setData] = useState({ stats: { memory: {}, cpu: {}, disk: {} }, apps: [] });
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadData() {
      try {
        const [statsRes, appsRes] = await Promise.all([
          axios.get('/api/stats'),
          axios.get('/api/apps')
        ]);
        setData({ stats: statsRes.data, apps: appsRes.data });
      } catch (e) {
        console.error('Failed to fetch data', e);
        setError(e.message + ' | URL: ' + (e.config?.url || 'N/A'));
      }
    }
    loadData();
  }, []);

  return (
    <div className="p-8 max-w-6xl mx-auto font-sans">
      {error && <div className="bg-red-900 text-white p-4 mb-4 rounded">Error: {error}</div>}
      <div className="flex justify-between items-center mb-10">
        <h1 className="text-2xl font-bold tracking-tight">K-PANEL</h1>
        <button onClick={() => window.location.reload()} className="bg-gray-900 px-4 py-2 rounded text-xs font-bold uppercase hover:bg-gray-800">Refresh</button>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-10">
        <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl">
          <p className="text-gray-500 text-[10px] uppercase font-bold tracking-widest mb-1">RAM</p>
          <div className="text-2xl font-bold">{(data.stats.memory.used / 1024**3 || 0).toFixed(1)}GB</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl">
          <p className="text-gray-500 text-[10px] uppercase font-bold tracking-widest mb-1">CPU</p>
          <div className="text-2xl font-bold">{data.stats.cpu.cores || 0} Cores</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl">
          <p className="text-gray-500 text-[10px] uppercase font-bold tracking-widest mb-1">DISK</p>
          <div className="text-2xl font-bold">{data.stats.disk.percent || 0}%</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl">
          <p className="text-gray-500 text-[10px] uppercase font-bold tracking-widest mb-1">APPS</p>
          <div className="text-2xl font-bold">{data.apps.length}</div>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-800 text-gray-400 uppercase text-[10px] tracking-widest">
            <tr><th className="p-4">CONTAINER</th><th className="p-4">STATUS</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {data.apps.map(app => (
              <tr key={app.id}>
                <td className="p-4 font-bold">{app.name}</td>
                <td className="p-4 text-blue-400">{app.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
