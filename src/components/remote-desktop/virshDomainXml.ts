import type { VirtualMachineCreateForm } from './virshTypes';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildDomainXml(form: VirtualMachineCreateForm) {
  const disk = form.storageMode === 'new-volume' || form.storageMode === 'existing-volume'
    ? `
    <disk type="volume" device="disk">
      <driver name="qemu" type="${form.storageMode === 'new-volume' ? 'qcow2' : form.diskFormat}"/>
      <source pool="${escapeXml(form.storagePool)}" volume="${escapeXml(form.volumeName)}"/>
      <target dev="vda" bus="virtio"/>
    </disk>`
    : form.storageMode === 'existing-path'
      ? `
    <disk type="file" device="disk">
      <driver name="qemu" type="${form.diskFormat}"/>
      <source file="${escapeXml(form.diskPath.trim())}"/>
      <target dev="vda" bus="virtio"/>
    </disk>`
      : '';
  const cdrom = form.isoPath.trim()
    ? `
    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="${escapeXml(form.isoPath.trim())}"/>
      <target dev="sda" bus="sata"/>
      <readonly/>
    </disk>`
    : '';
  const network = form.networkName
    ? `
    <interface type="network">
      <source network="${escapeXml(form.networkName)}"/>
      <model type="virtio"/>
    </interface>`
    : '';
  const boot = form.isoPath.trim() ? '<boot dev="cdrom"/><boot dev="hd"/>' : '<boot dev="hd"/>';

  return `<domain type="kvm">
  <name>${escapeXml(form.name.trim())}</name>
  ${form.description.trim() ? `<description>${escapeXml(form.description.trim())}</description>` : ''}
  <memory unit="MiB">${Math.max(128, Math.round(form.memoryMiB))}</memory>
  <currentMemory unit="MiB">${Math.max(128, Math.round(form.memoryMiB))}</currentMemory>
  <vcpu placement="static">${Math.max(1, Math.round(form.vcpus))}</vcpu>
  <os>
    <type arch="${escapeXml(form.architecture || 'x86_64')}">hvm</type>
    ${boot}
  </os>
  <features><acpi/><apic/></features>
  <cpu mode="host-model" check="partial"/>
  <clock offset="utc"/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>restart</on_crash>
  <devices>${disk}${cdrom}${network}
    <serial type="pty"><target port="0"/></serial>
    <console type="pty"><target type="serial" port="0"/></console>
    <input type="tablet" bus="usb"/>
    <graphics type="vnc" port="-1" autoport="yes" listen="127.0.0.1"/>
    <video><model type="virtio"/></video>
  </devices>
</domain>`;
}
