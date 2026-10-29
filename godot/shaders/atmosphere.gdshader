shader_type spatial;
render_mode unshaded, blend_add, cull_front, depth_draw_never;
void fragment() {
    float rim=pow(1.0-abs(dot(normalize(NORMAL),normalize(VIEW))),3.5);
    ALBEDO=vec3(0.13,0.42,0.82);
    ALPHA=rim*0.44;
}
