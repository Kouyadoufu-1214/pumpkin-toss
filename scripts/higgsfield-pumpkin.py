# Run these two stages in the linked Higgsfield 3D Jutsu project.
# Stage 1: create the mesh, inspect the render and dimensions.
import bpy, math
from mathutils import Vector
from math import sin, cos, pi, exp
scene=bpy.context.scene
def material(name,color,rough):
    m=bpy.data.materials.new(name); m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value=(*color,1)
    bs.inputs['Roughness'].default_value=rough
    return m
def mesh(name,verts,faces,mat):
    data=bpy.data.meshes.new(name); data.from_pydata(verts,[],faces); data.update()
    obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj)
    data.materials.append(mat)
    for p in data.polygons:p.use_smooth=True
    return obj
orange=material('Skin • burnt orange',(0.62,.165,.018),.64)
wood=material('Stem • cork and wood',(.12,.072,.023),.92)
green=material('Leaf • olive',(.09,.18,.025),.82)
N=128; M=64; verts=[]; faces=[]
for j in range(M+1):
    t=pi*j/M; h=cos(t); s=sin(t)
    for i in range(N+1):
        a=2*pi*i/N
        rib=.935+.065*cos(10*a+.08*sin(t*2))
        radius=s*rib*(1+.07*s*s)*(1+.018*sin(3*a)*s)
        height=.91*h-(.13 if h>=0 else -.08)*exp(-(s/.26)**2)
        verts.append((radius*sin(a),-radius*cos(a),height+.014*sin(a)*s*s))
for j in range(M):
    for i in range(N):
        a=j*(N+1)+i; b=a+N+1
        if j==0:faces.append((a,b,b+1))
        elif j==M-1:faces.append((a,b,a+1))
        else:faces.append((a,b,b+1,a+1))
shell=mesh('pumpkin-shell',verts,faces,orange)
uv=shell.data.uv_layers.new(name='UVMap')
for p in shell.data.polygons:
    for li in p.loop_indices:
        vi=shell.data.loops[li].vertex_index
        uv.data[li].uv=(vi%(N+1)/N,1-vi//(N+1)/M)
verts=[];faces=[];rings=24;sides=12
for j in range(rings+1):
    u=j/rings; r=.115*(1-.48*u)*(1+.12*sin(u*7))
    for i in range(sides):
        a=2*pi*i/sides+.22*u
        rad=r*(1+.10*cos(a*6))
        verts.append((.20*u*u+rad*cos(a),.02*u+rad*sin(a),.75+.48*u))
for j in range(rings):
    for i in range(sides):
        a=j*sides+i;b=j*sides+(i+1)%sides
        faces.append((a,b,b+sides,a+sides))
faces.append(tuple(range(sides-1,-1,-1)))
faces.append(tuple(rings*sides+i for i in range(sides)))
stem=mesh('pumpkin-stem',verts,faces,wood)
verts=[];faces=[]
for j in range(21):
    u=j/20; w=.135*sin(pi*u)**.8*(1+.14*sin(u*pi*8))
    for side in [-1,0,1]:
        verts.append((-.04-.56*u,-.015+side*w,.87+.18*sin(pi*u)-.04*u-abs(side)*.045*sin(pi*u)))
for j in range(20):
    a=j*3;faces.extend([(a,a+3,a+4,a+1),(a+1,a+4,a+5,a+2)])
leaf=mesh('pumpkin-leaf',verts,faces,green)
green.use_backface_culling=False
camera_data=bpy.data.cameras.new('CAM_main'); camera=bpy.data.objects.new('CAM_main',camera_data);scene.collection.objects.link(camera)
camera.location=(3,-6,2.5);target=Vector((0,0,.13));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler()
camera_data.type='ORTHO';camera_data.ortho_scale=3.25;scene.camera=camera
def point(name,pos,power,color,radius):
    d=bpy.data.lights.new(name,'POINT');d.energy=power;d.color=color;d.shadow_soft_size=radius
    o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=pos
point('LGT_key',(-3,-4,5),950,(1,.82,.63),2.0)
point('LGT_fill',(4,-1,2),240,(.58,.7,1),2)
scene.world=bpy.data.worlds.new('World • plum studio');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.065,.042,.08,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.35
scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
scene.render.image_settings.media_type='IMAGE';scene.render.image_settings.file_format='PNG'
bpy.context.view_layer.update()
target=artifacts.file(name='pumpkin-blockout.png',media_type='image/png');scene.render.filepath=str(target.path);bpy.ops.render.render(write_still=True);target.publish()
result={'meshes':[{'name':o.name,'dimensions':list(o.dimensions),'vertices':len(o.data.vertices),'faces':len(o.data.polygons)} for o in [shell,stem,leaf]],'camera':camera.name}

# Stage 2: materials, after the shape has passed inspection.
import bpy, math, numpy as np
from mathutils import Vector, noise
from math import sin, cos, pi
scene=bpy.context.scene
shell=bpy.data.objects['pumpkin-shell']
N=512
height=np.zeros((N,N),dtype=np.float32)
rgb=np.zeros((N,N,4),dtype=np.float32);rgb[:,:,3]=1
rough=np.ones((N,N,4),dtype=np.float32)
for j in range(N):
    t=pi*(1-(j+.5)/N)
    for i in range(N):
        a=2*pi*(i+.5)/N
        v=Vector((sin(t)*sin(a),-sin(t)*cos(a),cos(t)))
        broad=noise.noise(v*4.5)
        medium=noise.noise(v*26)
        fine=noise.noise(v*155)
        groove=(1-cos(10*a+.08*sin(t*2)))*.5
        variation=.07*broad+.025*medium+.012*fine-.026*groove
        rgb[j,i,:3]=(.82+variation,.355+variation*.62,.038+variation*.17)
        height[j,i]=.50+.26*medium+.16*fine
        r=.69+.08*fine+.05*groove
        rough[j,i,:3]=r
dy,dx=np.gradient(height)
normal=np.zeros((N,N,4),dtype=np.float32);normal[:,:,3]=1
vectors=np.stack((-dx*1.8,-dy*1.8,np.ones_like(dx)),axis=2)
vectors/=np.linalg.norm(vectors,axis=2)[:,:,None]
normal[:,:,:3]=vectors*.5+.5
def image(name,data,noncolor=False):
    im=bpy.data.images.new(name,width=N,height=N,alpha=True)
    if noncolor:im.colorspace_settings.name='Non-Color'
    im.pixels.foreach_set(data.ravel());im.update();im.pack()
    return im
m=shell.data.materials[0];nodes=m.node_tree.nodes;links=m.node_tree.links;bs=nodes.get('Principled BSDF')
for label,data,socket,noncolor in [('Pumpkin peel color',rgb,'Base Color',False),('Pumpkin peel roughness',rough,'Roughness',True)]:
    n=nodes.new('ShaderNodeTexImage');n.image=image(label,data,noncolor);links.new(n.outputs['Color'],bs.inputs[socket])
n=nodes.new('ShaderNodeTexImage');n.image=image('Pumpkin peel normal',normal,True)
norm=nodes.new('ShaderNodeNormalMap');norm.inputs['Strength'].default_value=.5
links.new(n.outputs['Color'],norm.inputs['Color']);links.new(norm.outputs['Normal'],bs.inputs['Normal'])
for name in ['pumpkin-stem','pumpkin-leaf']:
    o=bpy.data.objects[name];col=o.data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='POINT')
    for v in o.data.vertices:
        x,y,z=v.co
        if name=='pumpkin-stem':
            a=math.atan2(y-.02*max(0,(z-.75)/.48),x-.2*max(0,(z-.75)/.48)**2)
            grain=.5+.5*sin(a*18+z*9)+.18*noise.noise(v.co*70)
            color=(.105+.08*grain,.062+.052*grain,.022+.023*grain,1)
        else:
            center=1 if v.index%3==1 else .0
            color=(.055+.055*center,.125+.09*center,.012+.017*center,1)
        col.data[v.index].color=color
    mat=o.data.materials[0];bs=mat.node_tree.nodes.get('Principled BSDF')
    attr=mat.node_tree.nodes.new('ShaderNodeVertexColor');attr.layer_name='Color'
    mat.node_tree.links.new(attr.outputs['Color'],bs.inputs['Base Color'])
bpy.data.lights['LGT_key'].energy=1700
bpy.data.lights['LGT_fill'].energy=460
d=bpy.data.lights.new('LGT_rim','POINT');d.energy=650;d.color=(.57,.66,1);d.shadow_soft_size=1.2
o=bpy.data.objects.new('LGT_rim',d);scene.collection.objects.link(o);o.location=(2,3,3)
scene.render.resolution_x=640;scene.render.resolution_y=640
target=artifacts.file(name='pumpkin-materials.png',media_type='image/png');scene.render.filepath=str(target.path)
scene.render.image_settings.media_type='IMAGE';scene.render.image_settings.file_format='PNG'
bpy.ops.render.render(write_still=True);target.publish()
result={'images':[{'name':im.name,'size':list(im.size),'packed':bool(im.packed_file)} for im in bpy.data.images if im.name.startswith('Pumpkin')],'triangles':sum(len(p.vertices)-2 for o in scene.objects if o.type=='MESH' for p in o.data.polygons),'parts':[o.name for o in scene.objects if o.type=='MESH']}

